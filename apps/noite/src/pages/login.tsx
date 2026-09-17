import { LoginPanel } from "$lib/login-panel";
import { head } from "@ilha/router";

export default function Login() {
  head({ title: "Login · Noite" });

  return (
    <div class="mx-auto mt-4 flex w-full max-w-5xl flex-col gap-4 px-4 pb-12">
      <div class="card bg-base-100 dark:bg-base-200 border-base-300 mx-auto w-full max-w-xl border shadow-md">
        <div class="card-body gap-4">
          <h2 class="card-title m-0">Noite</h2>
          <LoginPanel />
        </div>
      </div>
    </div>
  );
}
