import { isSignupEnabled } from "@/lib/signup";
import LoginForm from "@/app/login/LoginForm";

export const metadata = { title: "ログイン" };

export default function LoginPage() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-bold text-foreground">
          mfmf
        </h1>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          ペット保育園記録
        </p>
        <LoginForm signupEnabled={isSignupEnabled()} />
      </div>
    </main>
  );
}
