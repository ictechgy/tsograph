import { prisma } from './db';

export interface Store {
  save(value: string): Promise<void>;
}

export function createLog(): string[] {
  return [];
}

export class JobStore implements Store {
  private readonly log = createLog();

  constructor(private readonly prefix: string) {}

  async save(value: string) {
    await prisma.job.create({ data: { title: this.prefix + value } });
    this.touch();
  }

  touch() {
    return this.log.length;
  }
}

export class MemoryStore implements Store {
  async save(_value: string) {}
}

export async function saveVia(store: Store) {
  await store.save('unproven');
}

export async function saveProven() {
  const store: Store = new JobStore('p-');
  await store.save('proven');
}

export async function saveUnion(store: JobStore | MemoryStore) {
  await store.save('union');
}

export class Base {
  run() {
    return 'base';
  }
}

export class Derived extends Base {
  override run() {
    return 'derived';
  }
}

export class Plain extends Base {}

export function runBase(base: Base) {
  return base.run();
}
