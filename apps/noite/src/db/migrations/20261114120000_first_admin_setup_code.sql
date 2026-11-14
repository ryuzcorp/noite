CREATE TABLE IF NOT EXISTS `bootstrap_setup` (
	`codeHash` text NOT NULL,
	`consumedAt` text,
	`consumedBy` text,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`id` text PRIMARY KEY NOT NULL
);
