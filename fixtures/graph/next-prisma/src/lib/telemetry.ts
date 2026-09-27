import { track } from 'untyped-analytics';

export function report(event: string) {
  track(event);
}
