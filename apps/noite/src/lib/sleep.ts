/** setTimeout-based delay (the browser has no sleep primitive). */
export const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- a setTimeout-based delay needs a fresh Promise
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
