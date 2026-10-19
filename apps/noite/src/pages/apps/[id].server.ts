import { defineHead } from "void";

// The app's name refines the title client-side once its detail loads
// (`DocumentTitle` in the page); the server only knows the fallback.
export const head = defineHead(() => ({ title: "App · Noite" }));
