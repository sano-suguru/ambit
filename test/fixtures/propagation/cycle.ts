/** @effects pure */
export function pureEntryToCycle(): number {
  return cycleA();
}

function cycleA(): number {
  return cycleB() + 1;
}

function cycleB(): number {
  fetch("https://example.com");
  return cycleA();
}
