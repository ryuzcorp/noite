const res = await fetch("/api/greeting");
// SAFETY: the sample Worker answers /api/greeting with { greeting } (src/index.ts).
const { greeting } = (await res.json()) as { greeting: string };
const el = document.querySelector("#greeting");
if (el) {
  el.textContent = greeting;
}
