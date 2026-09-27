// 인터페이스와 구현 두 개(SQL·메모리), 그리고 구현이 쓰는 클라이언트다.
export interface ItemStore {
  findItem(id: string): Promise<string | null>;
  saveItem(id: string): Promise<void>;
}

export class SqlClient {
  query(sql: string): string {
    return sql;
  }
}

export class SqlItemStore implements ItemStore {
  constructor(private readonly client: SqlClient) {}

  async findItem(id: string) {
    return this.client.query(`select ${id}`);
  }

  async saveItem(id: string) {
    this.client.query(`insert ${id}`);
  }
}

export class MemoryItemStore implements ItemStore {
  private readonly items = new Set<string>();

  async findItem(id: string) {
    return this.items.has(id) ? id : null;
  }

  async saveItem(id: string) {
    this.items.add(id);
  }
}
