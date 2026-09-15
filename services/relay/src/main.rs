use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fmt::Write as FmtWrite;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HEADER_LEN: usize = 5;
const ADDRESS_HEADER_LEN: usize = 7;
const GREETING_LEN: usize = 9;
const DEFAULT_MAX_FRAME_LEN: usize = 4096;
const MAX_RESPONSE_CREDIT: u64 = 16 * 1024;
const ZT_PACKET_MIN_LEN: usize = 28;
const ZT_PACKET_DEST_OFFSET: usize = 8;
const ZT_PACKET_SOURCE_OFFSET: usize = 13;
const ZT_ADDRESS_LEN: usize = 5;
const RELAY_FLOW_ACTIVE_MS: u64 = 120_000;
const RELAY_FLOW_RETENTION_MS: u64 = 900_000;
const RELAY_FLOW_LIMIT: usize = 8_192;
const RELAY_SESSION_RETENTION_MS: u64 = 900_000;

#[derive(Clone, Debug)]
struct Config {
    listen: SocketAddr,
    metrics_listen: Option<SocketAddr>,
    allowed_sources: Vec<Ipv4Cidr>,
    max_connections: usize,
    max_connections_per_ip: usize,
    handshake_timeout: Duration,
    idle_timeout: Duration,
    packets_per_second: u64,
    bytes_per_second: u64,
    global_packets_per_second: u64,
    global_bytes_per_second: u64,
    max_destinations: usize,
    min_destination_port: u16,
    max_frame_len: usize,
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let listen = env_value("RELAY_LISTEN", "0.0.0.0:4443")
            .parse()
            .map_err(|e| format!("RELAY_LISTEN must be an IP socket address: {e}"))?;
        let metrics_raw = env_value("RELAY_METRICS_LISTEN", "0.0.0.0:9090");
        let metrics_listen =
            if metrics_raw.trim().is_empty() {
                None
            } else {
                Some(metrics_raw.parse().map_err(|e| {
                    format!("RELAY_METRICS_LISTEN must be an IP socket address: {e}")
                })?)
            };
        let allowed_sources = env::var("RELAY_ALLOWED_CIDRS")
            .unwrap_or_default()
            .split(',')
            .filter(|v| !v.trim().is_empty())
            .map(|v| Ipv4Cidr::from_str(v.trim()))
            .collect::<Result<Vec<_>, _>>()?;

        let cfg = Self {
            listen,
            metrics_listen,
            allowed_sources,
            max_connections: env_number("RELAY_MAX_CONNECTIONS", 128)?,
            max_connections_per_ip: env_number("RELAY_MAX_CONNECTIONS_PER_IP", 4)?,
            handshake_timeout: Duration::from_secs(env_number(
                "RELAY_HANDSHAKE_TIMEOUT_SECONDS",
                10,
            )?),
            idle_timeout: Duration::from_secs(env_number("RELAY_IDLE_TIMEOUT_SECONDS", 300)?),
            packets_per_second: env_number("RELAY_PACKETS_PER_SECOND", 200)?,
            bytes_per_second: env_number("RELAY_BYTES_PER_SECOND", 2_097_152)?,
            global_packets_per_second: env_number("RELAY_GLOBAL_PACKETS_PER_SECOND", 2_000)?,
            global_bytes_per_second: env_number("RELAY_GLOBAL_BYTES_PER_SECOND", 20_971_520)?,
            max_destinations: env_number("RELAY_MAX_DESTINATIONS", 64)?,
            min_destination_port: env_number("RELAY_MIN_DESTINATION_PORT", 1025)?,
            max_frame_len: env_number("RELAY_MAX_FRAME_LENGTH", DEFAULT_MAX_FRAME_LEN)?,
        };
        if cfg.max_connections == 0
            || cfg.max_connections_per_ip == 0
            || cfg.max_destinations == 0
            || cfg.max_frame_len < ADDRESS_HEADER_LEN + 16
            || cfg.max_frame_len > u16::MAX as usize
        {
            return Err("relay limits must be positive and frame length must be 23..65535".into());
        }
        Ok(cfg)
    }
}

fn env_value(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn env_number<T>(name: &str, default: T) -> Result<T, String>
where
    T: FromStr + std::fmt::Display + Copy,
    <T as FromStr>::Err: std::fmt::Display,
{
    env::var(name)
        .unwrap_or_else(|_| default.to_string())
        .parse::<T>()
        .map_err(|e| format!("{name} is invalid: {e}"))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Ipv4Cidr {
    network: u32,
    mask: u32,
}

impl FromStr for Ipv4Cidr {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (ip, prefix) = value
            .split_once('/')
            .ok_or_else(|| format!("CIDR must include prefix: {value}"))?;
        let ip: Ipv4Addr = ip
            .parse()
            .map_err(|_| format!("invalid IPv4 CIDR: {value}"))?;
        let prefix: u8 = prefix
            .parse()
            .map_err(|_| format!("invalid CIDR prefix: {value}"))?;
        if prefix > 32 {
            return Err(format!("CIDR prefix out of range: {value}"));
        }
        let mask = if prefix == 0 {
            0
        } else {
            u32::MAX << (32 - prefix)
        };
        Ok(Self {
            network: u32::from(ip) & mask,
            mask,
        })
    }
}

impl Ipv4Cidr {
    fn contains(&self, ip: Ipv4Addr) -> bool {
        u32::from(ip) & self.mask == self.network
    }
}

#[derive(Default)]
struct Metrics {
    accepted: AtomicU64,
    active: AtomicUsize,
    rejected_source: AtomicU64,
    rejected_capacity: AtomicU64,
    rejected_protocol: AtomicU64,
    rejected_destination: AtomicU64,
    rejected_rate: AtomicU64,
    rejected_udp_source: AtomicU64,
    rejected_amplification: AtomicU64,
    packets_to_udp: AtomicU64,
    packets_to_tcp: AtomicU64,
    bytes_to_udp: AtomicU64,
    bytes_to_tcp: AtomicU64,
}

impl Metrics {
    fn render(&self) -> String {
        format!(
            concat!(
                "# TYPE zt_relay_connections_total counter\nzt_relay_connections_total {}\n",
                "# TYPE zt_relay_connections_active gauge\nzt_relay_connections_active {}\n",
                "zt_relay_rejected_source_total {}\n",
                "zt_relay_rejected_capacity_total {}\n",
                "zt_relay_rejected_protocol_total {}\n",
                "zt_relay_rejected_destination_total {}\n",
                "zt_relay_rejected_rate_total {}\n",
                "zt_relay_rejected_udp_source_total {}\n",
                "zt_relay_rejected_amplification_total {}\n",
                "zt_relay_packets_to_udp_total {}\n",
                "zt_relay_packets_to_tcp_total {}\n",
                "zt_relay_bytes_to_udp_total {}\n",
                "zt_relay_bytes_to_tcp_total {}\n"
            ),
            self.accepted.load(Ordering::Relaxed),
            self.active.load(Ordering::Relaxed),
            self.rejected_source.load(Ordering::Relaxed),
            self.rejected_capacity.load(Ordering::Relaxed),
            self.rejected_protocol.load(Ordering::Relaxed),
            self.rejected_destination.load(Ordering::Relaxed),
            self.rejected_rate.load(Ordering::Relaxed),
            self.rejected_udp_source.load(Ordering::Relaxed),
            self.rejected_amplification.load(Ordering::Relaxed),
            self.packets_to_udp.load(Ordering::Relaxed),
            self.packets_to_tcp.load(Ordering::Relaxed),
            self.bytes_to_udp.load(Ordering::Relaxed),
            self.bytes_to_tcp.load(Ordering::Relaxed),
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RelayDirection {
    ToUdp,
    ToTcp,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Hash)]
struct FlowKey {
    source: u64,
    destination: u64,
}

#[derive(Clone, Debug, Default)]
struct FlowRecord {
    packets: u64,
    bytes: u64,
    first_seen: u64,
    last_seen: u64,
}

#[derive(Clone, Debug, Default)]
struct ClientTraffic {
    packets_in: u64,
    packets_out: u64,
    bytes_in: u64,
    bytes_out: u64,
    last_relayed_at: u64,
}

#[derive(Clone, Debug)]
struct SessionRecord {
    remote_address: String,
    started_at: u64,
    last_seen: u64,
    closed_at: Option<u64>,
    packets_to_udp: u64,
    packets_to_tcp: u64,
    bytes_to_udp: u64,
    bytes_to_tcp: u64,
    flows: BTreeMap<FlowKey, FlowRecord>,
}

#[derive(Default)]
struct TelemetryState {
    flows: BTreeMap<FlowKey, FlowRecord>,
    sessions: BTreeMap<u64, SessionRecord>,
    unattributed_packets: u64,
    unattributed_bytes: u64,
    dropped_flows: u64,
}

struct RelayTelemetry {
    boot_id: u64,
    state: Mutex<TelemetryState>,
}

impl RelayTelemetry {
    fn new() -> Self {
        Self {
            boot_id: now_millis(),
            state: Mutex::new(TelemetryState::default()),
        }
    }

    fn start_session(&self, session_id: u64, remote_address: String, now: u64) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        prune_telemetry(&mut state, now);
        state.sessions.insert(
            session_id,
            SessionRecord {
                remote_address,
                started_at: now,
                last_seen: now,
                closed_at: None,
                packets_to_udp: 0,
                packets_to_tcp: 0,
                bytes_to_udp: 0,
                bytes_to_tcp: 0,
                flows: BTreeMap::new(),
            },
        );
    }

    fn finish_session(&self, session_id: u64, now: u64) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = state.sessions.get_mut(&session_id) {
            session.closed_at = Some(now);
            session.last_seen = now;
        }
    }

    fn observe(&self, session_id: u64, direction: RelayDirection, payload: &[u8], now: u64) {
        if payload.is_empty() {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        prune_telemetry(&mut state, now);
        if let Some(session) = state.sessions.get_mut(&session_id) {
            session.last_seen = now;
            match direction {
                RelayDirection::ToUdp => {
                    session.packets_to_udp = session.packets_to_udp.saturating_add(1);
                    session.bytes_to_udp =
                        session.bytes_to_udp.saturating_add(payload.len() as u64);
                }
                RelayDirection::ToTcp => {
                    session.packets_to_tcp = session.packets_to_tcp.saturating_add(1);
                    session.bytes_to_tcp =
                        session.bytes_to_tcp.saturating_add(payload.len() as u64);
                }
            }
        }

        let Some((source, destination)) = parse_wire_addresses(payload) else {
            state.unattributed_packets = state.unattributed_packets.saturating_add(1);
            state.unattributed_bytes = state
                .unattributed_bytes
                .saturating_add(payload.len() as u64);
            return;
        };
        let key = FlowKey {
            source,
            destination,
        };
        let mut dropped_flows = state.dropped_flows;
        record_flow(
            &mut state.flows,
            key,
            payload.len() as u64,
            now,
            &mut dropped_flows,
            RELAY_FLOW_LIMIT,
        );
        if let Some(session) = state.sessions.get_mut(&session_id) {
            record_flow(
                &mut session.flows,
                key,
                payload.len() as u64,
                now,
                &mut dropped_flows,
                RELAY_FLOW_LIMIT,
            );
        }
        state.dropped_flows = dropped_flows;
    }

    fn render_json(&self, now: u64) -> String {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        prune_telemetry(&mut state, now);
        let mut out = String::with_capacity(4096);
        let boot_id = self.boot_id.to_string();
        write!(
            out,
            "{{\"version\":1,\"observerId\":null,\"bootId\":{},\"clock\":{},\"confidence\":\"wire_observed\",\"networkId\":null,\"transport\":\"tcp_relay\",\"flows\":[",
            json_quote(&boot_id),
            now
        )
        .unwrap();

        let mut clients: BTreeMap<u64, ClientTraffic> = BTreeMap::new();
        for (index, (key, value)) in state.flows.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let active =
                value.last_seen > 0 && now.saturating_sub(value.last_seen) <= RELAY_FLOW_ACTIVE_MS;
            write!(
                out,
                "{{\"sourceNodeId\":{},\"destinationNodeId\":{},\"transport\":\"tcp_relay\",\"packets\":{},\"bytes\":{},\"firstSeen\":{},\"lastSeen\":{},\"active\":{}}}",
                json_quote(&node_id(key.source)),
                json_quote(&node_id(key.destination)),
                json_quote(&value.packets.to_string()),
                json_quote(&value.bytes.to_string()),
                value.first_seen,
                value.last_seen,
                active
            )
            .unwrap();
            let source = clients.entry(key.source).or_default();
            source.packets_out = source.packets_out.saturating_add(value.packets);
            source.bytes_out = source.bytes_out.saturating_add(value.bytes);
            source.last_relayed_at = source.last_relayed_at.max(value.last_seen);
            let destination = clients.entry(key.destination).or_default();
            destination.packets_in = destination.packets_in.saturating_add(value.packets);
            destination.bytes_in = destination.bytes_in.saturating_add(value.bytes);
            destination.last_relayed_at = destination.last_relayed_at.max(value.last_seen);
        }
        out.push_str("],\"clients\":[");
        for (index, (node, value)) in clients.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let total = value.bytes_in.saturating_add(value.bytes_out);
            write!(
                out,
                "{{\"nodeId\":{},\"packetsIn\":{},\"packetsOut\":{},\"bytesIn\":{},\"bytesOut\":{},\"bytesTotal\":{},\"lastRelayedAt\":{}}}",
                json_quote(&node_id(*node)),
                json_quote(&value.packets_in.to_string()),
                json_quote(&value.packets_out.to_string()),
                json_quote(&value.bytes_in.to_string()),
                json_quote(&value.bytes_out.to_string()),
                json_quote(&total.to_string()),
                value.last_relayed_at
            )
            .unwrap();
        }
        out.push_str("],\"sessions\":[");
        for (index, (session_id, session)) in state.sessions.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let active = session.closed_at.is_none()
                && now.saturating_sub(session.last_seen) <= RELAY_FLOW_ACTIVE_MS;
            write!(
                out,
                "{{\"sessionId\":{},\"remoteAddress\":{},\"startedAt\":{},\"lastSeen\":{},\"closedAt\":{},\"active\":{},\"packetsToUdp\":{},\"packetsToTcp\":{},\"bytesToUdp\":{},\"bytesToTcp\":{},\"flowCount\":{}}}",
                session_id,
                json_quote(&session.remote_address),
                session.started_at,
                session.last_seen,
                session
                    .closed_at
                    .map(|value| json_quote(&value.to_string()))
                    .unwrap_or_else(|| "null".to_owned()),
                active,
                session.packets_to_udp,
                session.packets_to_tcp,
                session.bytes_to_udp,
                session.bytes_to_tcp,
                session.flows.len()
            )
            .unwrap();
        }
        write!(
            out,
            "],\"unattributed\":{{\"packets\":{},\"bytes\":{}}},\"droppedFlows\":{}}}",
            json_quote(&state.unattributed_packets.to_string()),
            json_quote(&state.unattributed_bytes.to_string()),
            json_quote(&state.dropped_flows.to_string())
        )
        .unwrap();
        out
    }

    fn render_prometheus(&self, now: u64) -> String {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        prune_telemetry(&mut state, now);
        let active_flows = state
            .flows
            .values()
            .filter(|flow| now.saturating_sub(flow.last_seen) <= RELAY_FLOW_ACTIVE_MS)
            .count();
        let active_sessions = state
            .sessions
            .values()
            .filter(|session| {
                session.closed_at.is_none()
                    && now.saturating_sub(session.last_seen) <= RELAY_FLOW_ACTIVE_MS
            })
            .count();
        format!(
            concat!(
                "# TYPE zt_relay_telemetry_active_flows gauge\nzt_relay_telemetry_active_flows {}\n",
                "# TYPE zt_relay_telemetry_active_sessions gauge\nzt_relay_telemetry_active_sessions {}\n",
                "# TYPE zt_relay_telemetry_unattributed_packets_total counter\nzt_relay_telemetry_unattributed_packets_total {}\n",
                "# TYPE zt_relay_telemetry_unattributed_bytes_total counter\nzt_relay_telemetry_unattributed_bytes_total {}\n",
                "# TYPE zt_relay_telemetry_dropped_flows_total counter\nzt_relay_telemetry_dropped_flows_total {}\n"
            ),
            active_flows,
            active_sessions,
            state.unattributed_packets,
            state.unattributed_bytes,
            state.dropped_flows
        )
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

fn node_id(address: u64) -> String {
    format!("{:010x}", address & 0xffffffffff)
}

fn json_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            character if character.is_control() => {
                write!(out, "\\u{:04x}", character as u32).unwrap();
            }
            character => out.push(character),
        }
    }
    out.push('"');
    out
}

fn parse_wire_addresses(payload: &[u8]) -> Option<(u64, u64)> {
    if payload.len() < ZT_PACKET_MIN_LEN {
        return None;
    }
    let destination = parse_address(&payload[ZT_PACKET_DEST_OFFSET..])?;
    let source = parse_address(&payload[ZT_PACKET_SOURCE_OFFSET..])?;
    if source == 0 || destination == 0 || source == destination {
        return None;
    }
    Some((source, destination))
}

fn parse_address(payload: &[u8]) -> Option<u64> {
    let bytes = payload.get(..ZT_ADDRESS_LEN)?;
    Some(
        bytes
            .iter()
            .fold(0u64, |value, byte| (value << 8) | u64::from(*byte)),
    )
}

fn record_flow(
    flows: &mut BTreeMap<FlowKey, FlowRecord>,
    key: FlowKey,
    bytes: u64,
    now: u64,
    dropped_flows: &mut u64,
    limit: usize,
) {
    if !flows.contains_key(&key) && flows.len() >= limit {
        let oldest = flows
            .iter()
            .min_by_key(|(_, value)| value.last_seen)
            .map(|(flow, _)| *flow);
        if let Some(oldest) = oldest {
            flows.remove(&oldest);
            *dropped_flows = dropped_flows.saturating_add(1);
        }
    }
    let value = flows.entry(key).or_default();
    if value.first_seen == 0 {
        value.first_seen = now;
    }
    value.last_seen = now;
    value.packets = value.packets.saturating_add(1);
    value.bytes = value.bytes.saturating_add(bytes);
}

fn prune_telemetry(state: &mut TelemetryState, now: u64) {
    state
        .flows
        .retain(|_, flow| now.saturating_sub(flow.last_seen) <= RELAY_FLOW_RETENTION_MS);
    state.sessions.retain(|_, session| {
        session
            .flows
            .retain(|_, flow| now.saturating_sub(flow.last_seen) <= RELAY_FLOW_RETENTION_MS);
        now.saturating_sub(session.last_seen) <= RELAY_SESSION_RETENTION_MS
    });
}

struct RateWindow {
    started: Instant,
    packets: u64,
    bytes: u64,
}

impl Default for RateWindow {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            packets: 0,
            bytes: 0,
        }
    }
}

impl RateWindow {
    fn allow(&mut self, bytes: u64, packet_limit: u64, byte_limit: u64) -> bool {
        if self.started.elapsed() >= Duration::from_secs(1) {
            self.started = Instant::now();
            self.packets = 0;
            self.bytes = 0;
        }
        if self.packets.saturating_add(1) > packet_limit
            || self.bytes.saturating_add(bytes) > byte_limit
        {
            return false;
        }
        self.packets += 1;
        self.bytes += bytes;
        true
    }
}

struct State {
    metrics: Metrics,
    telemetry: Arc<RelayTelemetry>,
    telemetry_token: Option<String>,
    per_ip: Mutex<HashMap<IpAddr, usize>>,
    global_rate: Mutex<RateWindow>,
    next_session_id: AtomicU64,
}

impl State {
    fn new() -> Self {
        Self {
            metrics: Metrics::default(),
            telemetry: Arc::new(RelayTelemetry::new()),
            telemetry_token: env::var("RELAY_TELEMETRY_TOKEN")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()),
            per_ip: Mutex::new(HashMap::new()),
            global_rate: Mutex::new(RateWindow::default()),
            next_session_id: AtomicU64::new(1),
        }
    }

    fn reserve(&self, ip: IpAddr, cfg: &Config) -> bool {
        // Reserve the global slot with CAS. A load followed by fetch_add lets
        // concurrent accepts cross the configured ceiling during a flood.
        loop {
            let active = self.metrics.active.load(Ordering::Acquire);
            if active >= cfg.max_connections {
                self.metrics
                    .rejected_capacity
                    .fetch_add(1, Ordering::Relaxed);
                return false;
            }
            if self
                .metrics
                .active
                .compare_exchange(active, active + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                break;
            }
        }
        let mut counts = self.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        let count = counts.entry(ip).or_default();
        if *count >= cfg.max_connections_per_ip {
            self.metrics.active.fetch_sub(1, Ordering::AcqRel);
            self.metrics
                .rejected_capacity
                .fetch_add(1, Ordering::Relaxed);
            return false;
        }
        *count += 1;
        self.metrics.accepted.fetch_add(1, Ordering::Relaxed);
        true
    }

    fn release(&self, ip: IpAddr) {
        let mut counts = self.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = counts.get_mut(&ip) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(&ip);
            }
        }
        self.metrics.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn main() {
    if env::args().nth(1).as_deref() == Some("--healthcheck") {
        let address =
            env_value("RELAY_METRICS_LISTEN", "0.0.0.0:9090").replace("0.0.0.0", "127.0.0.1");
        match TcpStream::connect_timeout(
            &address
                .parse()
                .unwrap_or_else(|_| "127.0.0.1:9090".parse().unwrap()),
            Duration::from_secs(2),
        ) {
            Ok(_) => std::process::exit(0),
            Err(_) => std::process::exit(1),
        }
    }
    let cfg = match Config::from_env() {
        Ok(cfg) => Arc::new(cfg),
        Err(error) => {
            eprintln!("configuration error: {error}");
            std::process::exit(2);
        }
    };
    let state = Arc::new(State::new());
    if let Some(metrics_addr) = cfg.metrics_listen {
        let metrics_state = Arc::clone(&state);
        thread::spawn(move || serve_metrics(metrics_addr, metrics_state));
    }

    let listener = TcpListener::bind(cfg.listen).unwrap_or_else(|error| {
        eprintln!("unable to bind relay on {}: {error}", cfg.listen);
        std::process::exit(1);
    });
    eprintln!(
        "ztplanet relay listening on {} (client authentication is not part of the ZeroTier fallback protocol)",
        cfg.listen
    );

    for incoming in listener.incoming() {
        let stream = match incoming {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("accept failed: {error}");
                continue;
            }
        };
        let peer = match stream.peer_addr() {
            Ok(peer) => peer,
            Err(_) => continue,
        };
        if !source_allowed(peer.ip(), &cfg.allowed_sources) {
            state
                .metrics
                .rejected_source
                .fetch_add(1, Ordering::Relaxed);
            continue;
        }
        if !state.reserve(peer.ip(), &cfg) {
            continue;
        }
        let session_id = state.next_session_id.fetch_add(1, Ordering::Relaxed);
        let client_cfg = Arc::clone(&cfg);
        let client_state = Arc::clone(&state);
        thread::spawn(move || {
            if let Err(error) = handle_client(stream, &client_cfg, &client_state, session_id) {
                if !matches!(
                    error.kind(),
                    io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset
                ) {
                    eprintln!("relay client {} closed: {}", peer.ip(), error);
                }
            }
            client_state.release(peer.ip());
        });
    }
}

fn source_allowed(ip: IpAddr, allowed: &[Ipv4Cidr]) -> bool {
    if allowed.is_empty() {
        return true;
    }
    match ip {
        IpAddr::V4(ip) => allowed.iter().any(|cidr| cidr.contains(ip)),
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(|v4| allowed.iter().any(|cidr| cidr.contains(v4)))
            .unwrap_or(false),
    }
}

fn handle_client(
    mut tcp: TcpStream,
    cfg: &Config,
    state: &Arc<State>,
    session_id: u64,
) -> io::Result<()> {
    tcp.set_nodelay(true)?;
    tcp.set_read_timeout(Some(Duration::from_secs(1)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut greeting = [0u8; GREETING_LEN];
    read_exact_until(&mut tcp, &mut greeting, cfg.handshake_timeout)?;
    if greeting[..5] != [0x17, 0x03, 0x03, 0x00, 0x04] {
        state
            .metrics
            .rejected_protocol
            .fetch_add(1, Ordering::Relaxed);
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid ZeroTier greeting",
        ));
    }

    let udp = UdpSocket::bind("0.0.0.0:0")?;
    let remote_address = tcp
        .peer_addr()
        .map(|address| address.to_string())
        .unwrap_or_default();
    state
        .telemetry
        .start_session(session_id, remote_address, now_millis());
    udp.set_read_timeout(Some(Duration::from_secs(1)))?;
    let udp_reader = udp.try_clone()?;
    let mut tcp_writer = tcp.try_clone()?;
    let running = Arc::new(AtomicBool::new(true));
    let response_running = Arc::clone(&running);
    // Each contacted destination carries a bounded response-byte credit. This
    // both authenticates the UDP reply source and prevents a small request from
    // turning the relay into an unbounded amplification service.
    let destinations = Arc::new(Mutex::new(HashMap::<SocketAddr, u64>::new()));
    let response_destinations = Arc::clone(&destinations);
    let response_state = Arc::clone(state);
    let response_telemetry = Arc::clone(&state.telemetry);
    let response_cfg = cfg.clone();
    let response_thread = thread::spawn(move || {
        let mut packet = [0u8; 4096];
        let mut response_rate = RateWindow::default();
        while response_running.load(Ordering::Acquire) {
            match udp_reader.recv_from(&mut packet) {
                Ok((length, source)) => {
                    {
                        let mut credits = response_destinations
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        let Some(credit) = credits.get_mut(&source) else {
                            response_state
                                .metrics
                                .rejected_udp_source
                                .fetch_add(1, Ordering::Relaxed);
                            continue;
                        };
                        if length as u64 > *credit {
                            response_state
                                .metrics
                                .rejected_amplification
                                .fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                        *credit -= length as u64;
                    }
                    let local_allowed = response_rate.allow(
                        length as u64,
                        response_cfg.packets_per_second,
                        response_cfg.bytes_per_second,
                    );
                    let global_allowed = response_state
                        .global_rate
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .allow(
                            length as u64,
                            response_cfg.global_packets_per_second,
                            response_cfg.global_bytes_per_second,
                        );
                    if !local_allowed || !global_allowed {
                        response_state
                            .metrics
                            .rejected_rate
                            .fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    if write_frame(&mut tcp_writer, source, &packet[..length]).is_err() {
                        break;
                    }
                    response_telemetry.observe(
                        session_id,
                        RelayDirection::ToTcp,
                        &packet[..length],
                        now_millis(),
                    );
                    response_state
                        .metrics
                        .packets_to_tcp
                        .fetch_add(1, Ordering::Relaxed);
                    response_state
                        .metrics
                        .bytes_to_tcp
                        .fetch_add(length as u64, Ordering::Relaxed);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => break,
            }
        }
        response_running.store(false, Ordering::Release);
    });

    let result = relay_requests(
        &mut tcp,
        &udp,
        cfg,
        state,
        &running,
        &destinations,
        session_id,
    );
    running.store(false, Ordering::Release);
    let _ = response_thread.join();
    state.telemetry.finish_session(session_id, now_millis());
    result
}

fn relay_requests(
    tcp: &mut TcpStream,
    udp: &UdpSocket,
    cfg: &Config,
    state: &Arc<State>,
    running: &AtomicBool,
    destinations: &Mutex<HashMap<SocketAddr, u64>>,
    session_id: u64,
) -> io::Result<()> {
    let mut local_rate = RateWindow::default();
    while running.load(Ordering::Acquire) {
        let mut header = [0u8; HEADER_LEN];
        read_record_header(tcp, &mut header, cfg.idle_timeout, cfg.handshake_timeout)?;
        if header[..3] != [0x17, 0x03, 0x03] {
            state
                .metrics
                .rejected_protocol
                .fetch_add(1, Ordering::Relaxed);
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid frame header",
            ));
        }
        let frame_len = u16::from_be_bytes([header[3], header[4]]) as usize;
        if !(ADDRESS_HEADER_LEN + 16..=cfg.max_frame_len).contains(&frame_len) {
            state
                .metrics
                .rejected_protocol
                .fetch_add(1, Ordering::Relaxed);
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid frame length",
            ));
        }
        let mut frame = vec![0u8; frame_len];
        read_exact_until(tcp, &mut frame, cfg.handshake_timeout)?;
        let (destination, payload) = match parse_client_frame(&frame, cfg.min_destination_port) {
            Ok(parsed) => parsed,
            Err(FrameError::Protocol(message)) => {
                state
                    .metrics
                    .rejected_protocol
                    .fetch_add(1, Ordering::Relaxed);
                return Err(io::Error::new(io::ErrorKind::InvalidData, message));
            }
            Err(FrameError::Destination) => {
                state
                    .metrics
                    .rejected_destination
                    .fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };
        let is_new_destination = !destinations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&destination);
        if is_new_destination
            && destinations.lock().unwrap_or_else(|e| e.into_inner()).len() >= cfg.max_destinations
        {
            state
                .metrics
                .rejected_destination
                .fetch_add(1, Ordering::Relaxed);
            continue;
        }
        let local_allowed = local_rate.allow(
            payload.len() as u64,
            cfg.packets_per_second,
            cfg.bytes_per_second,
        );
        let global_allowed = state
            .global_rate
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .allow(
                payload.len() as u64,
                cfg.global_packets_per_second,
                cfg.global_bytes_per_second,
            );
        if !local_allowed || !global_allowed {
            state.metrics.rejected_rate.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        {
            // Keep the reply reader behind this lock until the successful send
            // is recorded. A fast UDP reply must not race its allowlist entry.
            let mut credits = destinations.lock().unwrap_or_else(|e| e.into_inner());
            udp.send_to(payload, destination)?;
            state
                .telemetry
                .observe(session_id, RelayDirection::ToUdp, payload, now_millis());
            let credit = credits.entry(destination).or_default();
            let additional = (payload.len() as u64).saturating_mul(4).max(512);
            *credit = credit.saturating_add(additional).min(MAX_RESPONSE_CREDIT);
        }
        state.metrics.packets_to_udp.fetch_add(1, Ordering::Relaxed);
        state
            .metrics
            .bytes_to_udp
            .fetch_add(payload.len() as u64, Ordering::Relaxed);
    }
    Ok(())
}

fn read_exact_until(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    timeout: Duration,
) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    read_exact_deadline(stream, buffer, deadline)
}

fn read_exact_deadline(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    deadline: Instant,
) -> io::Result<()> {
    let mut offset = 0;
    while offset < buffer.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "frame deadline exceeded",
            ));
        }
        // Bound each read by the remaining absolute deadline, including reads
        // that keep returning one byte before the socket's timeout expires.
        stream.set_read_timeout(Some(remaining.min(Duration::from_secs(1))))?;
        match stream.read(&mut buffer[offset..]) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
            Ok(read) => {
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "frame deadline exceeded",
                    ));
                }
                offset += read;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "frame deadline exceeded",
                    ));
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn read_record_header(
    stream: &mut TcpStream,
    header: &mut [u8; HEADER_LEN],
    idle_timeout: Duration,
    assembly_timeout: Duration,
) -> io::Result<()> {
    read_exact_until(stream, &mut header[..1], idle_timeout)?;
    read_exact_until(stream, &mut header[1..], assembly_timeout)
}

#[derive(Debug, Eq, PartialEq)]
enum FrameError {
    Protocol(&'static str),
    Destination,
}

fn parse_client_frame(
    frame: &[u8],
    min_destination_port: u16,
) -> Result<(SocketAddr, &[u8]), FrameError> {
    if frame.len() < ADDRESS_HEADER_LEN + 16 {
        return Err(FrameError::Protocol("ZeroTier payload is too short"));
    }
    if frame[0] != 4 {
        return Err(FrameError::Protocol("only IPv4 fallback is supported"));
    }
    let ip = Ipv4Addr::new(frame[1], frame[2], frame[3], frame[4]);
    let port = u16::from_be_bytes([frame[5], frame[6]]);
    if !is_global_unicast(ip) || port < min_destination_port {
        return Err(FrameError::Destination);
    }
    Ok((
        SocketAddr::new(IpAddr::V4(ip), port),
        &frame[ADDRESS_HEADER_LEN..],
    ))
}

fn write_frame(stream: &mut TcpStream, source: SocketAddr, payload: &[u8]) -> io::Result<()> {
    let ip = match source.ip() {
        IpAddr::V4(ip) => ip,
        IpAddr::V6(_) => return Ok(()),
    };
    let frame_len = ADDRESS_HEADER_LEN + payload.len();
    if frame_len > u16::MAX as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "UDP response too large",
        ));
    }
    let mut header = [0u8; HEADER_LEN + ADDRESS_HEADER_LEN];
    header[0..3].copy_from_slice(&[0x17, 0x03, 0x03]);
    header[3..5].copy_from_slice(&(frame_len as u16).to_be_bytes());
    header[5] = 4;
    header[6..10].copy_from_slice(&ip.octets());
    header[10..12].copy_from_slice(&source.port().to_be_bytes());
    stream.write_all(&header)?;
    stream.write_all(payload)
}

fn is_global_unicast(ip: Ipv4Addr) -> bool {
    let value = u32::from(ip);
    let blocked = [
        ("0.0.0.0/8", 0),
        ("10.0.0.0/8", 0),
        ("100.64.0.0/10", 0),
        ("127.0.0.0/8", 0),
        ("169.254.0.0/16", 0),
        ("172.16.0.0/12", 0),
        ("192.0.0.0/24", 0),
        ("192.0.2.0/24", 0),
        ("192.88.99.0/24", 0),
        ("192.168.0.0/16", 0),
        ("198.18.0.0/15", 0),
        ("198.51.100.0/24", 0),
        ("203.0.113.0/24", 0),
        ("224.0.0.0/4", 0),
        ("240.0.0.0/4", 0),
    ];
    !blocked.iter().any(|(cidr, _)| {
        let range = Ipv4Cidr::from_str(cidr).expect("static CIDR is valid");
        value & range.mask == range.network
    })
}

fn serve_metrics(address: SocketAddr, state: Arc<State>) {
    let listener = match TcpListener::bind(address) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("metrics listener {} failed: {}", address, error);
            return;
        }
    };
    for mut stream in listener.incoming().flatten() {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let mut request = [0u8; 1024];
        let length = stream.read(&mut request).unwrap_or(0);
        let request_line = String::from_utf8_lossy(&request[..length]);
        let (status, content_type, body) = if request_line.starts_with("GET /metrics ") {
            (
                "200 OK",
                "text/plain; version=0.0.4; charset=utf-8",
                format!(
                    "{}{}",
                    state.metrics.render(),
                    state.telemetry.render_prometheus(now_millis())
                ),
            )
        } else if request_line.starts_with("GET /relay/telemetry ")
            && telemetry_request_authorized(&request_line, state.telemetry_token.as_deref())
        {
            (
                "200 OK",
                "application/json; charset=utf-8",
                state.telemetry.render_json(now_millis()),
            )
        } else if request_line.starts_with("GET /relay/telemetry ") {
            (
                "401 Unauthorized",
                "text/plain; charset=utf-8",
                "unauthorized\n".to_owned(),
            )
        } else if request_line.starts_with("GET /healthz ") {
            ("200 OK", "text/plain; charset=utf-8", "ok\n".to_owned())
        } else {
            (
                "404 Not Found",
                "text/plain; charset=utf-8",
                "not found\n".to_owned(),
            )
        };
        let date = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|v| v.as_secs())
            .unwrap_or_default();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Relay-Time: {date}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
    }
}

fn telemetry_request_authorized(request: &str, expected: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    request.lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        name.eq_ignore_ascii_case("x-relay-telemetry-token") && value.trim() == expected
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_deadline_rejects_even_buffered_data() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut sender = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut receiver, _) = listener.accept().unwrap();
        sender.write_all(b"already buffered").unwrap();
        let error = read_exact_deadline(&mut receiver, &mut [0u8; 1], Instant::now()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn continuous_trickle_cannot_extend_frame_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut sender = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut receiver, _) = listener.accept().unwrap();
        let writer = thread::spawn(move || {
            for _ in 0..20 {
                if sender.write_all(&[1]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        });
        let start = Instant::now();
        let result = read_exact_until(&mut receiver, &mut [0u8; 20], Duration::from_millis(100));
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_millis(350));
        drop(receiver);
        writer.join().unwrap();
    }

    #[test]
    fn cidr_matching_is_exact() {
        let cidr = Ipv4Cidr::from_str("192.168.4.0/24").unwrap();
        assert!(cidr.contains("192.168.4.55".parse().unwrap()));
        assert!(!cidr.contains("192.168.5.1".parse().unwrap()));
    }

    #[test]
    fn relay_destination_policy_blocks_non_public_ranges() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.169.254",
            "192.88.99.1",
            "100.64.0.1",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(
                !is_global_unicast(ip.parse().unwrap()),
                "{ip} must be blocked"
            );
        }
        assert!(is_global_unicast("1.1.1.1".parse().unwrap()));
        assert!(is_global_unicast("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn source_allowlist_empty_means_user_selected_any_source() {
        assert!(source_allowed("203.0.113.2".parse().unwrap(), &[]));
        let list = vec![Ipv4Cidr::from_str("203.0.113.0/24").unwrap()];
        assert!(source_allowed("203.0.113.2".parse().unwrap(), &list));
        assert!(!source_allowed("198.51.100.2".parse().unwrap(), &list));
    }

    #[test]
    fn connection_reservation_never_crosses_global_limit() {
        let state = State::new();
        let cfg = Config {
            listen: "127.0.0.1:4443".parse().unwrap(),
            metrics_listen: None,
            allowed_sources: vec![],
            max_connections: 1,
            max_connections_per_ip: 4,
            handshake_timeout: Duration::from_secs(1),
            idle_timeout: Duration::from_secs(1),
            packets_per_second: 1,
            bytes_per_second: 1,
            global_packets_per_second: 1,
            global_bytes_per_second: 1,
            max_destinations: 1,
            min_destination_port: 1025,
            max_frame_len: DEFAULT_MAX_FRAME_LEN,
        };
        let ip = "198.51.100.20".parse().unwrap();
        assert!(state.reserve(ip, &cfg));
        assert!(!state.reserve("198.51.100.21".parse().unwrap(), &cfg));
        state.release(ip);
        assert!(state.reserve("198.51.100.21".parse().unwrap(), &cfg));
    }

    #[test]
    fn strict_frame_parser_accepts_only_new_ipv4_protocol() {
        let mut valid = vec![0u8; ADDRESS_HEADER_LEN + 16];
        valid[0] = 4;
        valid[1..5].copy_from_slice(&[1, 1, 1, 1]);
        valid[5..7].copy_from_slice(&9993u16.to_be_bytes());
        let (destination, payload) = parse_client_frame(&valid, 1025).unwrap();
        assert_eq!(destination, "1.1.1.1:9993".parse().unwrap());
        assert_eq!(payload.len(), 16);

        valid[0] = 6;
        assert!(matches!(
            parse_client_frame(&valid, 1025),
            Err(FrameError::Protocol(_))
        ));
        assert!(matches!(
            parse_client_frame(&[4, 1, 1], 1025),
            Err(FrameError::Protocol(_))
        ));
    }

    #[test]
    fn malformed_frame_lengths_never_panic() {
        for length in 0..(ADDRESS_HEADER_LEN + 16) {
            let frame = vec![0xa5; length];
            assert!(parse_client_frame(&frame, 1025).is_err());
        }
    }

    #[test]
    fn response_credit_is_bounded() {
        let mut credit = 0u64;
        for _ in 0..100 {
            let additional = 4096u64.saturating_mul(4).max(512);
            credit = credit.saturating_add(additional).min(MAX_RESPONSE_CREDIT);
        }
        assert_eq!(credit, MAX_RESPONSE_CREDIT);
    }

    #[test]
    fn wire_header_parser_extracts_zero_tier_addresses() {
        let mut packet = vec![0u8; ZT_PACKET_MIN_LEN];
        packet[ZT_PACKET_DEST_OFFSET..ZT_PACKET_DEST_OFFSET + ZT_ADDRESS_LEN]
            .copy_from_slice(&[0x01, 0x02, 0x03, 0x04, 0x05]);
        packet[ZT_PACKET_SOURCE_OFFSET..ZT_PACKET_SOURCE_OFFSET + ZT_ADDRESS_LEN]
            .copy_from_slice(&[0x0a, 0x0b, 0x0c, 0x0d, 0x0e]);
        assert_eq!(
            parse_wire_addresses(&packet),
            Some((0x0a0b0c0d0e, 0x0102030405))
        );
        assert!(parse_wire_addresses(&packet[..ZT_PACKET_MIN_LEN - 1]).is_none());
        packet[ZT_PACKET_SOURCE_OFFSET..ZT_PACKET_SOURCE_OFFSET + ZT_ADDRESS_LEN]
            .copy_from_slice(&[0x01, 0x02, 0x03, 0x04, 0x05]);
        assert!(parse_wire_addresses(&packet).is_none());
    }

    #[test]
    fn relay_telemetry_aggregates_flows_and_session_directions() {
        let telemetry = RelayTelemetry {
            boot_id: 42,
            state: Mutex::new(TelemetryState::default()),
        };
        telemetry.start_session(7, "198.51.100.20:443".to_owned(), 1_000);
        let mut packet = vec![0u8; ZT_PACKET_MIN_LEN + 3];
        packet[ZT_PACKET_DEST_OFFSET..ZT_PACKET_DEST_OFFSET + ZT_ADDRESS_LEN]
            .copy_from_slice(&[0x01, 0x02, 0x03, 0x04, 0x05]);
        packet[ZT_PACKET_SOURCE_OFFSET..ZT_PACKET_SOURCE_OFFSET + ZT_ADDRESS_LEN]
            .copy_from_slice(&[0x0a, 0x0b, 0x0c, 0x0d, 0x0e]);
        telemetry.observe(7, RelayDirection::ToUdp, &packet, 1_001);
        telemetry.observe(7, RelayDirection::ToTcp, &packet, 1_002);
        let json = telemetry.render_json(1_003);
        assert!(json.contains("\"sourceNodeId\":\"0a0b0c0d0e\""));
        assert!(json.contains("\"destinationNodeId\":\"0102030405\""));
        assert!(json.contains("\"bytes\":\"62\""));
        assert!(json.contains("\"packetsToUdp\":1"));
        assert!(json.contains("\"packetsToTcp\":1"));
        assert!(json.contains("\"active\":true"));
        telemetry.finish_session(7, 1_004);
        let closed = telemetry.render_json(1_005);
        assert!(closed.contains("\"closedAt\":\"1004\""));
        assert!(closed.contains("\"active\":false"));
    }
}
