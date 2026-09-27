import { ghost } from './missing-module';

export function withAuth<T extends (...args: never[]) => unknown>(handler: T): T {
  return ((...args: never[]) => handler(...args)) as T;
}

export function callAny(value: any) {
  return value.run();
}

export function chooseLater(flag: boolean) {
  const chosen = flag ? formatA : formatB;
  return chosen();
}

export function callGhost() {
  return ghost();
}

export function pick(flag: boolean) {
  return (flag ? formatA : formatB)();
}

function formatA() {
  return 'a';
}

function formatB() {
  return 'b';
}
