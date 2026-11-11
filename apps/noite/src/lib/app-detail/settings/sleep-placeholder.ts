/** The idle-sleep default's placeholder, in the largest exact unit. */
export const sleepPlaceholder = (seconds: number): string => {
  if (seconds === 0) {
    return "Default: never";
  }

  if (seconds % 3600 === 0) {
    return `Default: ${seconds / 3600} h`;
  }

  if (seconds % 60 === 0) {
    return `Default: ${seconds / 60} min`;
  }

  return `Default: ${seconds} s`;
};
