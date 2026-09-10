import { type ReactNode, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "~/utils/api";

const numberValue = (value: string) => Number.parseInt(value, 10) || 0;
const cidrValue = (value: string) =>
	value
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean);

const Field = ({
	label,
	hint = "",
	children,
}: { label: string; hint?: string; children: ReactNode }) => (
	<label className="form-control w-full">
		<div className="label pb-1">
			<span className="label-text font-medium">{label}</span>
		</div>
		{children}
		{hint ? <span className="mt-1 text-xs text-base-content/60">{hint}</span> : null}
	</label>
);

const NumberField = ({
	label,
	value,
	min = 0,
	max = 65535,
	onChange,
	hint = "",
}: {
	label: string;
	value: number;
	min?: number;
	max?: number;
	onChange: (value: number) => void;
	hint?: string;
}) => (
	<Field label={label} hint={hint}>
		<input
			type="number"
			className="input input-bordered w-full"
			value={value}
			min={min}
			max={max}
			onChange={(event) => onChange(numberValue(event.target.value))}
		/>
	</Field>
);

const Toggle = ({
	label,
	checked,
	onChange,
	hint = "",
}: {
	label: string;
	checked: boolean;
	onChange: (value: boolean) => void;
	hint?: string;
}) => (
	<label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-base-300 p-3">
		<span>
			<span className="block font-medium">{label}</span>
			{hint ? <span className="text-xs text-base-content/60">{hint}</span> : null}
		</span>
		<input
			type="checkbox"
			className="toggle toggle-primary"
			checked={checked}
			onChange={(event) => onChange(event.target.checked)}
		/>
	</label>
);

const Card = ({
	title,
	description = "",
	children,
}: { title: string; description?: string; children: ReactNode }) => (
	<section className="rounded-xl border border-base-300 bg-base-100 p-5 shadow-sm">
		<h2 className="text-lg font-semibold">{title}</h2>
		{description ? (
			<p className="mt-1 text-sm text-base-content/70">{description}</p>
		) : null}
		<div className="mt-4 space-y-4">{children}</div>
	</section>
);

export default function SystemExposure() {
	const status = api.system.status.useQuery(undefined, { refetchOnWindowFocus: false });
	const clientConfig = api.system.clientConfig.useQuery(undefined, { enabled: false });
	const audit = api.system.audit.useQuery(undefined, { enabled: false });
	const validateMutation = api.system.validate.useMutation();
	const applyMutation = api.system.apply.useMutation();
	const rollbackMutation = api.system.rollback.useMutation();
	const certificateMutation = api.system.generateCertificate.useMutation();
	const customCertificateMutation = api.system.installCustomCertificate.useMutation();
	const tokenMutation = api.system.rotateControllerToken.useMutation();
	const [draft, setDraft] = useState<any>(null);
	const [revision, setRevision] = useState(0);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [password, setPassword] = useState("");
	const [certificateNames, setCertificateNames] = useState("localhost,127.0.0.1");
	const [customCertificate, setCustomCertificate] = useState("");
	const [customPrivateKey, setCustomPrivateKey] = useState("");
	const composeReadOnly = status.data?.mode === "compose-read-only";

	useEffect(() => {
		if (status.data && !draft) {
			setDraft(structuredClone(status.data.config));
			setRevision(status.data.revision);
		}
	}, [status.data, draft]);

	const update = (section: string, key: string, value: unknown) => {
		setDraft((current) => ({
			...current,
			[section]: { ...current[section], [key]: value },
		}));
	};

	const updateListener = (index: number, key: string, value: unknown) => {
		setDraft((current) => {
			const listeners = current.management.listeners.map((item, itemIndex) =>
				itemIndex === index ? { ...item, [key]: value } : item,
			);
			return { ...current, management: { ...current.management, listeners } };
		});
	};

	const runValidation = async () => {
		if (composeReadOnly) {
			toast.error("当前 1Panel 粘贴模式为只读，请修改环境变量后重新部署");
			return;
		}
		try {
			const result = await validateMutation.mutateAsync({ config: draft });
			setDraft(result.config);
			setWarnings(result.warnings);
			toast.success("Configuration is valid / 配置校验通过");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Configuration validation failed",
			);
		}
	};

	const apply = async () => {
		if (composeReadOnly) {
			toast.error("当前 1Panel 粘贴模式没有宿主机配置代理，不能在线应用");
			return;
		}
		try {
			const result = await applyMutation.mutateAsync({
				config: draft,
				expectedRevision: revision,
				idempotencyKey: crypto.randomUUID().replaceAll("-", ""),
				password: password || undefined,
			});
			setDraft(structuredClone(result.config));
			setRevision(result.revision);
			setWarnings(result.warnings || []);
			setPassword("");
			await status.refetch();
			toast.success("Configuration applied / 配置已应用");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Configuration apply failed");
		}
	};

	if (status.error) {
		return (
			<div className="alert alert-error">
				Configuration agent unavailable: {status.error.message}
			</div>
		);
	}
	if (status.isLoading || !draft) {
		return (
			<div className="flex min-h-48 items-center justify-center">
				<span className="loading loading-spinner" />
			</div>
		);
	}

	return (
		<div className="space-y-6 pb-16">
			<div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
				<strong>安全边界：</strong>绑定公网、关闭 TLS
				和开放任意来源不会被强制禁止，但会要求管理员重新认证并写入审计日志。TCP fallback
				的外层协议不是 TLS，也没有客户端认证。
			</div>
			{composeReadOnly ? (
				<div className="alert alert-info">
					<div>
						<strong>1Panel 粘贴模式：只读系统状态</strong>
						<p className="text-sm">{status.data?.message}</p>
						<p className="text-sm">
							页面仍可查看 Compose 的监听配置；请在 1Panel 环境变量或同目录 .env
							修改后重新编排。在线校验、原子应用、证书、回滚和令牌轮换需要宿主机配置代理。
						</p>
					</div>
				</div>
			) : null}

			<Card
				title="Effective exposure / 实际暴露面"
				description={`Revision ${revision} · ${status.data?.updatedAt || ""}`}
			>
				<div className="overflow-x-auto">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>Purpose</th>
								<th>Protocol</th>
								<th>Endpoint</th>
								<th>TLS</th>
								<th>Authentication / source</th>
								<th>Health</th>
								<th>Risk</th>
							</tr>
						</thead>
						<tbody>
							{(status.data?.exposures || []).map((row, index) => (
								<tr key={`${row.purpose}-${row.address}-${row.port}-${index}`}>
									<td>{row.purpose}</td>
									<td>{row.protocol.toUpperCase()}</td>
									<td className="font-mono">
										{row.address}:{row.port}
									</td>
									<td>{row.tls}</td>
									<td>
										{row.authentication}; {row.allowedSources.join(", ")}
									</td>
									<td>{row.health}</td>
									<td>{row.risk}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{status.data?.drift?.length ? (
					<div className="alert alert-error">
						Configuration drift: {status.data.drift.join(", ")}
					</div>
				) : (
					<div className="alert alert-success py-2">
						Generated files match the applied revision.
					</div>
				)}
				<details className="rounded-lg border border-base-300 p-3">
					<summary className="cursor-pointer font-medium">
						Host listening sockets / 宿主机实际监听
					</summary>
					<pre className="mt-3 max-h-48 overflow-auto text-xs">
						{JSON.stringify(status.data?.actualListeners || [], null, 2)}
					</pre>
				</details>
				{Object.keys(status.data?.relayMetrics || {}).length ? (
					<details className="rounded-lg border border-base-300 p-3">
						<summary className="cursor-pointer font-medium">
							Relay health metrics / 中继运行指标
						</summary>
						<pre className="mt-3 max-h-48 overflow-auto text-xs">
							{JSON.stringify(status.data?.relayMetrics, null, 2)}
						</pre>
					</details>
				) : null}
			</Card>

			<Card
				title="Management listeners / 管理端监听"
				description="可同时绑定回环、两个内网、ZeroTier 地址或公网地址。"
			>
				<Field label="Canonical public URL / 标准访问地址">
					<input
						className="input input-bordered"
						value={draft.management.publicUrl}
						onChange={(event) => update("management", "publicUrl", event.target.value)}
					/>
				</Field>
				{draft.management.listeners.map((listener, index) => (
					<div
						key={index}
						className="grid gap-3 rounded-lg border border-base-300 p-4 md:grid-cols-5"
					>
						<Field label="Bind IP">
							<input
								className="input input-bordered"
								value={listener.address}
								onChange={(event) => updateListener(index, "address", event.target.value)}
							/>
						</Field>
						<NumberField
							label="Port"
							value={listener.port}
							min={1}
							onChange={(value) => updateListener(index, "port", value)}
						/>
						<Field label="TLS">
							<select
								className="select select-bordered"
								value={listener.tlsMode}
								onChange={(event) => updateListener(index, "tlsMode", event.target.value)}
							>
								<option value="self-signed">Self-signed</option>
								<option value="files">Mounted certificate</option>
								<option value="off">Off / HTTP</option>
							</select>
						</Field>
						<Field label="Allowed CIDRs" hint="空白表示任意来源">
							<input
								className="input input-bordered"
								value={listener.allowedCidrs.join(",")}
								onChange={(event) =>
									updateListener(index, "allowedCidrs", cidrValue(event.target.value))
								}
							/>
						</Field>
						<button
							className="btn btn-outline btn-error self-end"
							disabled={draft.management.listeners.length === 1}
							onClick={() =>
								update(
									"management",
									"listeners",
									draft.management.listeners.filter(
										(_, itemIndex) => itemIndex !== index,
									),
								)
							}
						>
							Remove
						</button>
					</div>
				))}
				<button
					className="btn btn-outline"
					disabled={draft.management.listeners.length >= 16}
					onClick={() =>
						update("management", "listeners", [
							...draft.management.listeners,
							{
								address: "127.0.0.1",
								port: 3443,
								tlsMode: "self-signed",
								allowedCidrs: [],
							},
						])
					}
				>
					Add listener
				</button>
				<Toggle
					label="Allow management through an existing ZeroTier interface / 允许虚拟网访问管理端"
					checked={draft.management.allowZeroTier}
					onChange={(value) => update("management", "allowZeroTier", value)}
				/>
				<div className="grid gap-3 md:grid-cols-2">
					<Field label="ZeroTier interface">
						<input
							list="zt-interface-list"
							className="input input-bordered"
							value={draft.management.zeroTierInterface}
							onChange={(event) =>
								update("management", "zeroTierInterface", event.target.value)
							}
							placeholder="ztxxxxxxxx"
						/>
						<datalist id="zt-interface-list">
							{status.data?.zeroTierInterfaces?.map((item) => (
								<option key={item.name} value={item.name} />
							))}
						</datalist>
					</Field>
					<Field label="ZeroTier bind address">
						<input
							list="zt-address-list"
							className="input input-bordered"
							value={draft.management.zeroTierAddress}
							onChange={(event) =>
								update("management", "zeroTierAddress", event.target.value)
							}
						/>
						<datalist id="zt-address-list">
							{status.data?.zeroTierInterfaces?.flatMap((item) =>
								item.addresses.map((address) => (
									<option key={`${item.name}-${address}`} value={address} />
								)),
							)}
						</datalist>
					</Field>
				</div>
				<div className="grid gap-3 md:grid-cols-3">
					<NumberField
						label="Session seconds"
						value={draft.management.sessionMaxAgeSeconds}
						min={900}
						max={28800}
						onChange={(value) => update("management", "sessionMaxAgeSeconds", value)}
					/>
					<NumberField
						label="Failed attempts"
						value={draft.management.loginAttempts}
						min={1}
						max={20}
						onChange={(value) => update("management", "loginAttempts", value)}
					/>
					<NumberField
						label="Lockout seconds"
						value={draft.management.loginLockoutSeconds}
						min={60}
						max={86400}
						onChange={(value) => update("management", "loginLockoutSeconds", value)}
					/>
				</div>
			</Card>

			<Card title="ZeroTier root and Controller">
				<Toggle
					label="Expose the ZeroTier root UDP listener / 开放根节点 UDP"
					checked={draft.zerotier.enabled}
					onChange={(value) => update("zerotier", "enabled", value)}
				/>
				<div className="grid gap-3 md:grid-cols-3">
					<Field label="Public UDP bind IP">
						<input
							className="input input-bordered"
							value={draft.zerotier.bindAddress}
							onChange={(event) => update("zerotier", "bindAddress", event.target.value)}
						/>
					</Field>
					<NumberField
						label="Public UDP port"
						value={draft.zerotier.publicPort}
						min={1}
						onChange={(value) => update("zerotier", "publicPort", value)}
					/>
					<NumberField
						label="Secondary port (0=auto)"
						value={draft.zerotier.secondaryPort}
						onChange={(value) => update("zerotier", "secondaryPort", value)}
					/>
					<NumberField
						label="Tertiary port (0=auto)"
						value={draft.zerotier.tertiaryPort}
						onChange={(value) => update("zerotier", "tertiaryPort", value)}
					/>
				</div>
				<div className="grid gap-3 md:grid-cols-2">
					<Toggle
						label="Allow secondary port"
						checked={draft.zerotier.allowSecondaryPort}
						onChange={(value) => update("zerotier", "allowSecondaryPort", value)}
					/>
					<Toggle
						label="Enable UPnP/NAT-PMP mapping"
						checked={draft.zerotier.portMappingEnabled}
						onChange={(value) => update("zerotier", "portMappingEnabled", value)}
					/>
				</div>
				<div className="grid gap-3 md:grid-cols-3">
					<Field label="Controller exposure">
						<select
							className="select select-bordered"
							value={draft.controller.exposure}
							onChange={(event) => update("controller", "exposure", event.target.value)}
						>
							<option value="internal">Internal only</option>
							<option value="https">Through management HTTPS</option>
							<option value="direct">Direct token/HTTP</option>
						</select>
					</Field>
					<Field label="Controller bind IP">
						<input
							className="input input-bordered"
							value={draft.controller.bindAddress}
							onChange={(event) =>
								update("controller", "bindAddress", event.target.value)
							}
						/>
					</Field>
					<NumberField
						label="Controller port"
						value={draft.controller.port}
						min={1}
						onChange={(value) => update("controller", "port", value)}
					/>
				</div>
			</Card>

			<Card
				title="Hardened TCP fallback relay / 加固 TCP 中继"
				description="443 不是固定端口。标准客户端协议没有认证；来源为空时表示用户选择允许任意来源。"
			>
				<Toggle
					label="Enable public TCP fallback relay"
					checked={draft.relayServer.enabled}
					onChange={(value) => update("relayServer", "enabled", value)}
				/>
				<div className="grid gap-3 md:grid-cols-3">
					<Field label="Bind IP">
						<input
							className="input input-bordered"
							value={draft.relayServer.bindAddress}
							onChange={(event) =>
								update("relayServer", "bindAddress", event.target.value)
							}
						/>
					</Field>
					<NumberField
						label="TCP port"
						value={draft.relayServer.port}
						min={1}
						onChange={(value) => update("relayServer", "port", value)}
						hint="443 仅为建议，可使用 9443 等任意端口"
					/>
					<Field label="Allowed source CIDRs">
						<input
							className="input input-bordered"
							value={draft.relayServer.allowedSourceCidrs.join(",")}
							onChange={(event) =>
								update("relayServer", "allowedSourceCidrs", cidrValue(event.target.value))
							}
						/>
					</Field>
					<NumberField
						label="Global connections"
						value={draft.relayServer.maxConnections}
						min={1}
						max={4096}
						onChange={(value) => update("relayServer", "maxConnections", value)}
					/>
					<NumberField
						label="Connections per IP"
						value={draft.relayServer.maxConnectionsPerIp}
						min={1}
						max={256}
						onChange={(value) => update("relayServer", "maxConnectionsPerIp", value)}
					/>
					<NumberField
						label="Packets/s per connection"
						value={draft.relayServer.packetsPerSecond}
						min={1}
						max={100000}
						onChange={(value) => update("relayServer", "packetsPerSecond", value)}
					/>
					<NumberField
						label="Bytes/s per connection"
						value={draft.relayServer.bytesPerSecond}
						min={1024}
						max={1073741824}
						onChange={(value) => update("relayServer", "bytesPerSecond", value)}
					/>
					<NumberField
						label="Global packets/s"
						value={draft.relayServer.globalPacketsPerSecond}
						min={1}
						max={1000000}
						onChange={(value) => update("relayServer", "globalPacketsPerSecond", value)}
					/>
					<NumberField
						label="Global bytes/s"
						value={draft.relayServer.globalBytesPerSecond}
						min={1024}
						max={10737418240}
						onChange={(value) => update("relayServer", "globalBytesPerSecond", value)}
					/>
					<NumberField
						label="Handshake timeout"
						value={draft.relayServer.handshakeTimeoutSeconds}
						min={1}
						max={60}
						onChange={(value) => update("relayServer", "handshakeTimeoutSeconds", value)}
					/>
					<NumberField
						label="Idle timeout"
						value={draft.relayServer.idleTimeoutSeconds}
						min={30}
						max={3600}
						onChange={(value) => update("relayServer", "idleTimeoutSeconds", value)}
					/>
					<NumberField
						label="Destinations per connection"
						value={draft.relayServer.maxDestinations}
						min={1}
						max={1024}
						onChange={(value) => update("relayServer", "maxDestinations", value)}
					/>
					<NumberField
						label="Minimum UDP destination port"
						value={draft.relayServer.minDestinationPort}
						min={1}
						onChange={(value) => update("relayServer", "minDestinationPort", value)}
					/>
				</div>
			</Card>

			<Card
				title="Client fallback policy / 客户端回退策略"
				description="服务端中继开关不会自动修改其他设备，需把生成的 local.conf 部署到客户端。"
			>
				<div className="grid gap-3 md:grid-cols-3">
					<Field label="Mode">
						<select
							className="select select-bordered"
							value={draft.relayClient.mode}
							onChange={(event) => update("relayClient", "mode", event.target.value)}
						>
							<option value="off">Disabled</option>
							<option value="official-auto">Official automatic</option>
							<option value="custom-auto">Custom automatic</option>
							<option value="custom-force">Force custom (testing)</option>
						</select>
					</Field>
					<Field label="Custom relay host/IP">
						<input
							className="input input-bordered"
							value={draft.relayClient.host}
							onChange={(event) => update("relayClient", "host", event.target.value)}
						/>
					</Field>
					<NumberField
						label="Custom relay TCP port"
						value={draft.relayClient.port}
						min={1}
						onChange={(value) => update("relayClient", "port", value)}
					/>
				</div>
				<button className="btn btn-outline" onClick={() => clientConfig.refetch()}>
					Generate client local.conf
				</button>
				{clientConfig.data ? (
					<pre className="max-h-64 overflow-auto rounded-lg bg-neutral p-4 text-xs text-neutral-content">
						{JSON.stringify(clientConfig.data, null, 2)}
					</pre>
				) : null}
			</Card>

			<Card title="Certificates and audit / 证书与审计">
				<div className="grid gap-3 md:grid-cols-2">
					<Field label="Self-signed certificate names" hint="逗号分隔的 DNS 名称或 IP">
						<input
							className="input input-bordered"
							value={certificateNames}
							onChange={(event) => setCertificateNames(event.target.value)}
						/>
					</Field>
					<Field label="Administrator password">
						<input
							type="password"
							autoComplete="current-password"
							className="input input-bordered"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</Field>
				</div>
				<div className="flex flex-wrap gap-2">
					<button
						className="btn btn-outline"
						disabled={composeReadOnly || certificateMutation.isLoading}
						onClick={async () => {
							try {
								await certificateMutation.mutateAsync({
									names: cidrValue(certificateNames),
									password,
								});
								toast.success("Certificate generated");
							} catch (error) {
								toast.error(
									error instanceof Error
										? error.message
										: "Certificate generation failed",
								);
							}
						}}
					>
						Generate self-signed certificate
					</button>
					<button className="btn btn-outline" onClick={() => audit.refetch()}>
						Load audit log
					</button>
					<button
						className="btn btn-outline btn-error"
						disabled={composeReadOnly || rollbackMutation.isLoading}
						onClick={async () => {
							try {
								const result = await rollbackMutation.mutateAsync({ password });
								setRevision(result.revision);
								setDraft(structuredClone(result.config));
								await status.refetch();
								toast.success("Rolled back");
							} catch (error) {
								toast.error(error instanceof Error ? error.message : "Rollback failed");
							}
						}}
					>
						Rollback previous revision
					</button>
					<button
						className="btn btn-outline btn-warning"
						disabled={composeReadOnly || tokenMutation.isLoading}
						onClick={async () => {
							try {
								await tokenMutation.mutateAsync({ password });
								toast.success("Controller token rotated");
							} catch (error) {
								toast.error(
									error instanceof Error ? error.message : "Token rotation failed",
								);
							}
						}}
					>
						Rotate Controller token
					</button>
				</div>
				<details className="rounded-lg border border-base-300 p-3">
					<summary className="cursor-pointer font-medium">
						Install custom certificate / 安装用户证书
					</summary>
					<div className="mt-3 grid gap-3 md:grid-cols-2">
						<Field label="Certificate chain (PEM)">
							<textarea
								className="textarea textarea-bordered h-48 font-mono text-xs"
								value={customCertificate}
								onChange={(event) => setCustomCertificate(event.target.value)}
							/>
						</Field>
						<Field label="Private key (PEM)">
							<textarea
								className="textarea textarea-bordered h-48 font-mono text-xs"
								value={customPrivateKey}
								onChange={(event) => setCustomPrivateKey(event.target.value)}
							/>
						</Field>
					</div>
					<button
						className="btn btn-outline mt-3"
						disabled={composeReadOnly || customCertificateMutation.isLoading}
						onClick={async () => {
							try {
								await customCertificateMutation.mutateAsync({
									certificate: customCertificate,
									privateKey: customPrivateKey,
									password,
								});
								setCustomPrivateKey("");
								toast.success("Custom certificate installed");
							} catch (error) {
								toast.error(
									error instanceof Error ? error.message : "Certificate install failed",
								);
							}
						}}
					>
						Validate and install
					</button>
				</details>
				{audit.data ? (
					<pre className="max-h-80 overflow-auto rounded-lg bg-neutral p-4 text-xs text-neutral-content">
						{JSON.stringify(audit.data.events, null, 2)}
					</pre>
				) : null}
			</Card>

			{warnings.length ? (
				<div className="alert alert-warning">
					<div>
						<strong>Warnings requiring password confirmation:</strong>
						<ul className="mt-2 list-disc pl-5">
							{warnings.map((warning) => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					</div>
				</div>
			) : null}
			<div className="sticky bottom-3 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-base-300 bg-base-100/95 p-3 shadow-lg backdrop-blur">
				<span className="mr-auto text-sm">Applied revision: {revision}</span>
				<button
					className="btn btn-outline"
					disabled={composeReadOnly || validateMutation.isLoading}
					onClick={runValidation}
				>
					Validate / 校验
				</button>
				<button
					className="btn btn-primary"
					disabled={composeReadOnly || applyMutation.isLoading}
					onClick={apply}
				>
					Apply atomically / 原子应用
				</button>
			</div>
		</div>
	);
}
