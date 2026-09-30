/**
 * 글을 저장한다(인라인 핸들러가 부르는 이름 있는 함수).
 *
 * @param db D1 바인딩
 * @param title 제목
 */
export async function insertPost(db: D1Database, title: string): Promise<void> {
  await db.prepare('INSERT INTO posts (title) VALUES (?)').bind(title).run();
}
