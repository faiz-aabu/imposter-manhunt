import type { SupabaseClient } from "@supabase/supabase-js";

export type AuthLifecycleStatus = "loading" | "signed-out" | "signed-in";

export interface AuthLifecycleState {
  status: AuthLifecycleStatus;
  email: string | null;
}

export const LOCAL_SIGN_OUT_OPTIONS = { scope: "local" } as const;

export class AuthLifecycleController {
  private subscription: { unsubscribe(): void } | null = null;
  private initializationGeneration = 0;
  private refreshGeneration = 0;
  private authEventGeneration = 0;

  constructor(
    private readonly setState: (state: AuthLifecycleState) => void,
  ) {}

  async initialize(client: SupabaseClient | null): Promise<void> {
    const generation = ++this.initializationGeneration;
    this.refreshGeneration += 1;
    this.authEventGeneration = 0;
    this.disposeSubscription();
    this.setState({ status: "loading", email: null });

    if (!client) {
      this.setState({ status: "signed-out", email: null });
      return;
    }

    const subscription = client.auth.onAuthStateChange(
      (_event, session) => {
        if (generation !== this.initializationGeneration) {
          return;
        }
        this.authEventGeneration += 1;
        this.setState({
          status: session?.user.email ? "signed-in" : "signed-out",
          email: session?.user.email ?? null,
        });
      },
    );
    this.subscription = subscription.data.subscription;

    try {
      const { data } = await client.auth.getSession();
      if (
        generation === this.initializationGeneration &&
        this.authEventGeneration === 0
      ) {
        this.setState({
          status: data.session?.user.email ? "signed-in" : "signed-out",
          email: data.session?.user.email ?? null,
        });
      }
    } catch {
      if (
        generation === this.initializationGeneration &&
        this.authEventGeneration === 0
      ) {
        this.setState({ status: "signed-out", email: null });
      }
    }
  }

  async refresh(client: SupabaseClient | null): Promise<void> {
    const initializationGeneration = this.initializationGeneration;
    const refreshGeneration = ++this.refreshGeneration;
    const authEventGeneration = this.authEventGeneration;
    const canCommit = () =>
      initializationGeneration === this.initializationGeneration &&
      refreshGeneration === this.refreshGeneration &&
      authEventGeneration === this.authEventGeneration;

    if (!client) {
      if (canCommit()) {
        this.setState({ status: "signed-out", email: null });
      }
      return;
    }
    try {
      const { data } = await client.auth.getSession();
      if (canCommit()) {
        this.setState({
          status: data.session?.user.email ? "signed-in" : "signed-out",
          email: data.session?.user.email ?? null,
        });
      }
    } catch {
      if (canCommit()) {
        this.setState({ status: "signed-out", email: null });
      }
    }
  }

  dispose(): void {
    this.initializationGeneration += 1;
    this.refreshGeneration += 1;
    this.disposeSubscription();
  }

  private disposeSubscription(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }
}
