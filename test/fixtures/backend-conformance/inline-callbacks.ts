// A function expression written directly as a call argument, with no
// enclosing declaration whose body contains it. DESIGN.md §4.1 (a) gives
// every such function in a file one entry, `<inline callbacks>`.

declare const router: {
  post(name: string, handler: (url: string) => Promise<void>): void;
  use(...handlers: Array<(url: string) => void>): void;
};

export async function ping(url: string): Promise<void> {
  await fetch(url);
}

// Two registrations, so the entry owns more than one body and `bodies` says
// which of them holds what.
router.post("first", async (url) => {
  await ping(url);
});

router.post("second", async (url) => {
  void url;
});

// Two callbacks in one call: both are owned, neither is nested in the other.
router.use(
  (url) => {
    void url;
  },
  (url) => {
    void url;
  },
);

// A callback inside a named function belongs to that function, not here.
export function register(): void {
  router.use((url) => {
    void url;
  });
}
