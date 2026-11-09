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
CREATE TABLE IF NOT EXISTS `invite` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`createdBy` text NOT NULL,
	`usedBy` text,
	`usedAt` text,
	`revoked` integer DEFAULT false NOT NULL,
	`note` text,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_invite_createdBy` ON `invite` (`createdBy`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_invite_code` ON `invite` (`code`);--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS `idx_verification_identifier` ON `verification` (`identifier`);