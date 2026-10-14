# Private group setup / 私有群组设置

## English

1. Add the bot to the private group and promote it to an administrator with permission to invite users. Telegram requires the `can_invite_users` right for bots to receive join-request updates and create invite links. Keep only the permissions the bot needs.
2. Import the question bank into D1 (`pnpm content:push --remote`), apply the D1 migrations, deploy the Worker and register its authenticated Telegram webhook. Run `/verify_status` in the group and confirm it reports the expected question-pack and rules versions before enabling the gate.
3. Configure the group with `/verify_config language=en timeoutSeconds=300 cooldownSeconds=1800`, then run `/verify_enable`. Use `language=cn` for Simplified Chinese. `/verify_status` reports the numeric group ID and active content/rules versions.
4. In the Telegram client, open the group’s invite-link management and create a **new** invite link that requires administrator approval (Telegram’s official announcement calls this “Request Admin Approval”). Client labels can vary. Do not use a regular invite link for gated admission.
5. Revoke older links that should no longer admit users without a request. Anyone holding an active non-approval link may bypass this bot’s join-request flow. Share only the approval link with prospective members.
6. Alternatively, after enabling verification, an authorized group admin can start the bot in a private chat and send `/verify_invite -100GROUP_ID`. The bot creates an approval-request link and returns it only in that private chat. A group `/verify_invite` command only explains this private workflow; it never posts the link to the group.

7. Optional: `/verify_config deleteJoinMessages=on` makes the bot delete Telegram’s “joined the group” service messages; `deleteJoinMessages=off` turns it off. It works whether or not verification is enabled. Grant the bot the delete-messages permission as well; without it the bot replies with a warning and the messages stay. Groups that never set this option, or that run `deleteJoinMessages=default`, follow the Worker variable `DELETE_JOIN_MESSAGES` (`true`/`false`, off by default).

This uses Telegram’s ordinary join-request approval flow. It does not require a third-party “Guard Bot” or a separate captcha service. Existing members are not re-verified just by enabling the bot; this flow applies to incoming join requests.

## 简体中文

1. 将机器人加入私有群组并设为管理员，授予“邀请成员”权限。Telegram 要求机器人具备 `can_invite_users` 才能收到入群申请更新并创建邀请链接。只授予运行所需的权限。
2. 将题库导入 D1（`pnpm content:push --remote`），执行 D1 迁移、部署 Worker 并注册带 secret 的 Telegram webhook。在群内运行 `/verify_status`，确认显示的题库和规则版本正确后再开启验证。
3. 使用 `/verify_config language=cn timeoutSeconds=300 cooldownSeconds=1800` 配置群组，再运行 `/verify_enable`。`language=en` 可切换为英文。`/verify_status` 会显示数字群组 ID 和当前内容/规则版本。
4. 在 Telegram 客户端的群组邀请链接管理中创建一条**新的**“需要管理员审批”邀请链接。Telegram 官方公告将此选项称为 “Request Admin Approval”；不同客户端的文案可能略有差异。不要使用普通邀请链接作为验证入口。
5. 撤销不应继续允许免审批加入的旧链接。持有仍有效的普通邀请链接的人可能绕过机器人的入群申请流程。只向预期成员分享需要审批的链接。
6. 验证已开启后，群管理员也可以先私聊机器人并发送 `/start`，再发送 `/verify_invite -100群组ID`。机器人会创建需要审批的链接，并且只在私聊中返回链接。群内执行 `/verify_invite` 只会提示上述私聊步骤，绝不会把链接发到群里。

7. 可选：`/verify_config deleteJoinMessages=on` 让机器人删除 Telegram 的“某人加入了群组”入群提示，`deleteJoinMessages=off` 关闭。该功能与是否开启验证无关。还需授予机器人“删除消息”权限；缺少权限时机器人会提示，入群提示不会被删除。从未设置过此项、或执行了 `deleteJoinMessages=default` 的群，跟随 Worker 变量 `DELETE_JOIN_MESSAGES`（`true`/`false`，默认关闭）。

此流程使用 Telegram 自带的普通入群申请审批，不需要第三方 “Guard Bot” 或单独的验证码服务。仅开启机器人不会重新验证现有成员；流程适用于之后发起的入群申请。

## Official references

- [Telegram: Join Requests for Groups and Channels](https://telegram.org/blog/shared-media-scrolling-calendar-join-requests-and-more#join-requests-for-groups-and-channels) — approval-request links and administrator review.
- [Telegram Bot API: `ChatJoinRequest`](https://core.telegram.org/bots/api#chatjoinrequest) — bots need the `can_invite_users` administrator right to receive join requests.
- [Telegram Bot API: `createChatInviteLink`](https://core.telegram.org/bots/api#createchatinvitelink) — bots need `can_invite_users`; `creates_join_request` makes link users submit requests.
