CREATE TABLE `learning_spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`restore_token` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learning_spaces_restore_token_unique` ON `learning_spaces` (`restore_token`);