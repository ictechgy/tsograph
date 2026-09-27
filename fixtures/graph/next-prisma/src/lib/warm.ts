import { isEven } from './cycle';

function warm() {
  return isEven(2);
}

export const warmed = warm();
