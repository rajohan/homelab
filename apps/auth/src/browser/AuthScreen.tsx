import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { SignInPage } from "./pages/SignInPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import type { AuthPageProps } from "./types";
/**
 * Select the authentication page from the current URL.
 * @param props - The identity client, current URL and optional email proof token.
 * @returns The component's rendered content for its current state.
 */
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
