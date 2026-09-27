// 합성 fixture용 최소 타입 선언이다(의존성을 설치하지 않는다).
declare module '@prisma/client' {
  interface Delegate {
    findMany(args?: unknown): Promise<unknown[]>;
    create(args: unknown): Promise<unknown>;
  }
  export class PrismaClient {
    job: Delegate;
    company: Delegate;
    auditLog: Delegate;
  }
}

declare module 'next/server' {
  export class NextResponse {
    static json(body: unknown): Response;
  }
}
