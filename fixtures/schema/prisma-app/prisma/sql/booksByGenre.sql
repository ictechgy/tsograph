-- 합성 TypedSQL 쿼리
SELECT b.id, b.title FROM "Book" b WHERE b.genre = $1
