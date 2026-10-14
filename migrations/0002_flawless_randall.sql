CREATE TABLE `blocklists` (
	`id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `members` (
	`group_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`messages` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`)
);
