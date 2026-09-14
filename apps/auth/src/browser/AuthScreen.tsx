import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { SignInPage } from "./pages/SignInPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import type { AuthPageProps } from "./types";
export function AuthScreen(props: AuthPageProps) {
    switch (props.address.pathname) {
        case "/forgot-password": {
            return <ForgotPasswordPage {...props} />;
        }
        case "/reset-password": {
            return <ResetPasswordPage {...props} />;
        }
        case "/verify-email": {
            return <VerifyEmailPage {...props} />;
        }
        default: {
            return <SignInPage {...props} />;
        }
    }
}
