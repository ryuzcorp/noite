-- The single post-reset baseline (0.2.0 beta reset): the only migration the
-- worker applies to a fresh control database, and the only name its ledger
-- may hold. The statements below refuse a pre-reset database before any
-- shape lands: when legacy ledger/pool tables exist, or the migration ledger
-- names anything but this baseline, the sentinel insert violates its named
-- CHECK and the migration fails with the reset message (the same text the
-- runner answers for its own database). SQLite's RAISE cannot carry a custom
-- message outside a trigger, so the message rides on the constraint's name.
CREATE TABLE IF NOT EXISTS `_void_migrations` (
	`name` TEXT PRIMARY KEY NOT NULL,
	`applied_at` TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_void_lineage_guard` (
	`id` INTEGER PRIMARY KEY NOT NULL CONSTRAINT "refusing to start: this database was written by a Noite release before the 0.2.0 beta reset and cannot be upgraded. Back it up if you need it, wipe the data volume and the bucket prefix (or use an empty bucket), then install fresh." CHECK (`id` > 0)
);
--> statement-breakpoint
INSERT INTO `_void_lineage_guard` (`id`) SELECT CASE WHEN EXISTS (
	SELECT 1 FROM `sqlite_master` WHERE type = 'table' AND name IN ('_migrations', 'invite', 'paranorm_idempotency', 'paranorm_migrations')
) OR EXISTS (
	SELECT 1 FROM `_void_migrations` WHERE name != '001_baseline'
) THEN -1 ELSE 1 END WHERE NOT EXISTS (SELECT 1 FROM `_void_lineage_guard`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` text,
	`refreshTokenExpiresAt` text,
	`scope` text,
	`password` text,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_account_userId` ON `account` (`userId`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`configId` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`referenceId` text NOT NULL,
	`prefix` text,
	`key` text NOT NULL,
	`refillInterval` integer,
	`refillAmount` integer,
	`lastRefillAt` text,
	`enabled` integer DEFAULT true NOT NULL,
	`rateLimitEnabled` integer DEFAULT false NOT NULL,
	`rateLimitTimeWindow` integer,
	`rateLimitMax` integer,
	`requestCount` integer DEFAULT 0 NOT NULL,
	`remaining` integer,
	`lastRequest` text,
	`expiresAt` text,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`permissions` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_apikey_key` ON `apikey` (`key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_apikey_referenceId` ON `apikey` (`referenceId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_apikey_configId` ON `apikey` (`configId`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `app_collaborator` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`userId` text NOT NULL,
	`role` text NOT NULL,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_app_collaborator_userId` ON `app_collaborator` (`userId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_app_collaborator_appId` ON `app_collaborator` (`appId`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_app_collaborator_appId_userId` ON `app_collaborator` (`appId`,`userId`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `collaborator_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`appName` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`invitedBy` text NOT NULL,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_collaborator_invite_email` ON `collaborator_invite` (`email`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_collaborator_invite_appId` ON `collaborator_invite` (`appId`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_collaborator_invite_appId_email` ON `collaborator_invite` (`appId`,`email`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`publicKey` text NOT NULL,
	`userId` text NOT NULL,
	`credentialID` text NOT NULL,
	`counter` integer NOT NULL,
	`deviceType` text NOT NULL,
	`backedUp` integer NOT NULL,
	`transports` text,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP,
	`aaguid` text,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_passkey_credentialID` ON `passkey` (`credentialID`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_passkey_userId` ON `passkey` (`userId`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` text NOT NULL,
	`token` text NOT NULL,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	`impersonatedBy` text,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_session_userId` ON `session` (`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_session_token` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'user' NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`banReason` text,
	`banExpires` text,
	`onboardedAt` text,
	`status` text DEFAULT 'active' NOT NULL,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_user_email` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` text NOT NULL,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_verification_identifier` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bootstrap_setup` (
	`codeHash` text NOT NULL,
	`consumedAt` text,
	`consumedBy` text,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
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
