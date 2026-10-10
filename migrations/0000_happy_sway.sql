CREATE TABLE `groups` (
	`group_id` integer PRIMARY KEY NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`key` text PRIMARY KEY NOT NULL,
	`group_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`effect_lease_until` integer,
	`cleanup_lease_until` integer,
	`cleanup_retry_at` integer,
	`message_id` integer,
	`message_deleted_at` integer,
	`request_date` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_group_request_date` ON `sessions` (`group_id`,`request_date`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user_request_date` ON `sessions` (`user_id`,`request_date`);--> statement-breakpoint
CREATE INDEX `idx_sessions_active_expiry` ON `sessions` (`expires_at`,`request_date`) WHERE "sessions"."status" in ('active', 'awaiting_rules');--> statement-breakpoint
CREATE INDEX `idx_sessions_pending_effect_due` ON `sessions` (coalesce(effect_lease_until, 0), `request_date`) WHERE "sessions"."status" in ('approve_pending', 'decline_pending');--> statement-breakpoint
CREATE INDEX `idx_sessions_cleanup_due` ON `sessions` (max(expires_at, coalesce(cleanup_retry_at, 0), coalesce(cleanup_lease_until, 0)), `request_date`) WHERE "sessions"."message_id" is not null and "sessions"."message_deleted_at" is null and "sessions"."status" in ('approved', 'declined');
