-- Drizzle 스키마 밖에서 원시 D1 SQL만 쓰는 테이블이다.
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event` text NOT NULL,
	`actor_id` integer
);
