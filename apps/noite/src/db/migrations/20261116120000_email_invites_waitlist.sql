ALTER TABLE `user` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `email_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`tokenHash` text NOT NULL,
	`createdBy` text NOT NULL,
	`expiresAt` text NOT NULL,
	`usedAt` text,
	`usedBy` text,
	`revoked` integer DEFAULT false NOT NULL,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_email_invite_tokenHash` ON `email_invite` (`tokenHash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_email_invite_email` ON `email_invite` (`email`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_email_invite_createdBy` ON `email_invite` (`createdBy`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `instance_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updatedAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
DROP TABLE `invite`;
