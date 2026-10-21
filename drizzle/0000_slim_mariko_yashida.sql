CREATE TABLE `answers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`word_id` text NOT NULL,
	`direction` text NOT NULL,
	`correct` integer NOT NULL,
	`is_retry` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `words` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`korean` text NOT NULL,
	`chinese` text NOT NULL,
	`created_at` integer NOT NULL,
	`mastery_ko` integer DEFAULT 0 NOT NULL,
	`mastery_zh` integer DEFAULT 0 NOT NULL,
	`mistakes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `words_user_korean_unique` ON `words` (`user_id`,`korean`);