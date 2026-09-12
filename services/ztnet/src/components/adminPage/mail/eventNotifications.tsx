import { useState } from "react";
import { api } from "~/utils/api";
import {
	defaultNotificationTemplate,
	eventLabels,
	eventTypes,
	type NotificationEventType,
} from "~/utils/notificationTemplates";
import MenuSectionDividerWrapper from "~/components/shared/menuSectionDividerWrapper";

const deliveryStatus: Record<string, string> = {
	pending: "等待发送",
	sending: "发送中",
	sent: "网关已确认",
	unknown: "结果未知",
	failed: "失败",
	cancelled: "已取消",
};
export default function EventNotifications() {
	const templates = api.notifications.templates.useQuery();
	const deliveries = api.notifications.deliveries.useQuery(undefined, {
		refetchInterval: 10000,
	});
	const [selected, setSelected] = useState<NotificationEventType>("node.offline");
	const [draft, setDraft] = useState<ReturnType<
		typeof defaultNotificationTemplate
	> | null>(null);
	const [notice, setNotice] = useState("");
	const [acknowledged, setAcknowledged] = useState(false);
	const template =
		draft ||
		templates.data?.templates.find((t) => t.eventType === selected) ||
		defaultNotificationTemplate(selected);
	const form = {
		eventType: selected,
		title: template.title,
		body: template.body,
		enabled: template.enabled,
	};
	const save = api.notifications.saveTemplate.useMutation({
		onSuccess: () => {
			void templates.refetch();
			setNotice("模板已保存，后续新事件使用此版本。");
		},
		onError: (e) => setNotice(e.message),
	});
	const preview = api.notifications.preview.useMutation({
		onError: (e) => setNotice(e.message),
	});
	const test = api.notifications.test.useMutation({
		onSuccess: () => {
			void deliveries.refetch();
			setNotice("测试消息已进入发送队列，请查看下方投递结果。");
		},
		onError: (e) => setNotice(e.message),
	});
	const retry = api.notifications.retry.useMutation({
		onSuccess: () => {
			void deliveries.refetch();
			setNotice("已重新加入发送队列。");
		},
		onError: (e) => setNotice(e.message),
	});
	const change = (values: Partial<typeof form>) =>
		setDraft({ ...template, ...values, eventType: selected });
	return (
		<MenuSectionDividerWrapper title="事件推送与消息模板" className="space-y-4">
			<p className="text-sm opacity-80">
				节点及账号操作通知发送到管理员上方配置的 Message Pusher
				渠道。请将该渠道限定为运维人员可见。密码、重置链接、验证码和会话令牌不会进入事件消息。个人邀请及找回密码邮件仍通过
				SMTP 发送给对应用户。
			</p>
			<div className="flex flex-wrap items-center gap-3">
				<label>
					事件类型{" "}
					<select
						className="select select-bordered select-sm"
						value={selected}
						onChange={(e) => {
							setSelected(e.target.value as NotificationEventType);
							setDraft(null);
							preview.reset();
							setNotice("");
						}}
					>
						{eventTypes.map((type) => (
							<option key={type} value={type}>
								{eventLabels[type]}
							</option>
						))}
					</select>
				</label>
				<label className="flex items-center gap-2">
					<input
						className="checkbox checkbox-sm"
						type="checkbox"
						checked={template.enabled}
						onChange={(e) => change({ enabled: e.target.checked })}
					/>
					启用此类通知
				</label>
			</div>
			<label className="form-control">
				<span className="label-text">消息标题</span>
				<input
					aria-label="消息标题"
					className="input input-bordered input-sm"
					value={template.title}
					maxLength={200}
					onChange={(e) => change({ title: e.target.value })}
				/>
			</label>
			<label className="form-control">
				<span className="label-text">正文模板</span>
				<textarea
					aria-label="正文模板"
					className="textarea textarea-bordered min-h-64 font-mono text-sm"
					value={template.body}
					maxLength={8000}
					onChange={(e) => change({ body: e.target.value })}
				/>
			</label>
			<details>
				<summary className="cursor-pointer text-sm">可用变量</summary>
				<div className="flex flex-wrap gap-2 pt-2">
					{templates.data?.variables.map((v) => (
						<code className="badge badge-outline" key={v}>{`{{${v}}}`}</code>
					))}
				</div>
				<p className="pt-2 text-sm">
					正文使用纯文本。时间采用带时区的 ISO 时间；无可靠记录的字段显示“未知 / 未采集”。
				</p>
			</details>
			<div className="flex flex-wrap gap-2">
				<button
					className="btn btn-primary btn-sm"
					disabled={save.isLoading}
					onClick={() => save.mutate(form)}
				>
					保存模板
				</button>
				<button
					className="btn btn-outline btn-sm"
					disabled={preview.isLoading}
					onClick={() => preview.mutate(form)}
				>
					预览示例
				</button>
				<button
					className="btn btn-ghost btn-sm"
					onClick={() => setDraft(defaultNotificationTemplate(selected))}
				>
					恢复默认内容
				</button>
				<button
					className="btn btn-outline btn-sm"
					disabled={test.isLoading}
					onClick={() => test.mutate()}
				>
					发送渠道测试
				</button>
			</div>
			{notice && (
				<p role="status" className="text-sm">
					{notice}
				</p>
			)}
			{preview.data && (
				<div className="rounded border border-base-300 p-4">
					<strong>{preview.data.title}</strong>
					<pre className="mt-3 whitespace-pre-wrap break-words text-sm">
						{preview.data.body}
					</pre>
				</div>
			)}
			<div className="space-y-2 pt-4">
				<h3 className="font-semibold">最近 100 条发送记录</h3>
				<p className="text-sm opacity-70">
					“网关已确认”表示推送网关报告成功，不代表收件人已阅读。结果未知时先检查目标渠道；网关没有幂等保证，重试可能重复发送。记录保留
					30 天。
				</p>
				<label className="flex items-center gap-2 text-sm">
					<input
						className="checkbox checkbox-xs"
						type="checkbox"
						checked={acknowledged}
						onChange={(e) => setAcknowledged(e.target.checked)}
					/>
					我已检查目标渠道，接受手动重试可能产生重复消息
				</label>
				<div className="overflow-x-auto">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>时间</th>
								<th>消息 / 模板版本</th>
								<th>投递结果</th>
								<th>操作</th>
							</tr>
						</thead>
						<tbody>
							{deliveries.data?.map((d) => (
								<tr key={d.id}>
									<td className="whitespace-nowrap">
										{new Date(d.createdAt).toLocaleString()}
									</td>
									<td>
										<details>
											<summary className="cursor-pointer">
												{d.title} · v{d.templateVersion}
											</summary>
											<pre className="max-w-xl whitespace-pre-wrap break-words text-xs">
												{d.body}
											</pre>
										</details>
									</td>
									<td>
										<span>{deliveryStatus[d.status] || d.status}</span>
										{d.lastError && <p className="max-w-xs text-xs">{d.lastError}</p>}
									</td>
									<td>
										{["unknown", "failed"].includes(d.status) && (
											<button
												disabled={!acknowledged || retry.isLoading}
												className="btn btn-xs"
												onClick={() =>
													retry.mutate({ id: d.id, acknowledgePossibleDuplicate: true })
												}
											>
												重试
											</button>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</MenuSectionDividerWrapper>
	);
}
