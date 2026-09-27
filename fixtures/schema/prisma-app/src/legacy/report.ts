import { DataSource } from 'typeorm';

// 지원 표면 밖 ORM — 쿼리는 사실이 되지 않고 개수로만 남는다.
export const legacySource = new DataSource({ type: 'postgres' });

export const REPORT_SQL = 'SELECT a.id FROM authors a JOIN "Book" b ON b."authorId" = a.id';
