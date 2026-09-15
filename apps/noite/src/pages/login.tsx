import { LoginPanel } from "$lib/login-panel";
import { head } from "@ilha/router";

export default function Login() {
  head({ title: "Login · Noite" });

  return (
    <div class="mx-auto mt-8 flex max-w-xl flex-col gap-4 px-4">
      <div class="card bg-base-100 shadow">
        <div class="card-body gap-4">
          <h2 class="card-title m-0">Noite</h2>
          <LoginPanel />
        </div>
      </div>
    </div>
  );
}
