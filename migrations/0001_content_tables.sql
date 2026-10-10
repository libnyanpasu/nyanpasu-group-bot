CREATE TABLE `packs` (
	`id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`type` text NOT NULL,
	`id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`type`, `id`)
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`payload` text NOT NULL
);
