import { Window as HappyDomWindow } from "happy-dom";

/**
 * Provide a per-test browser realm with manually delivered intersection observations.
 * @returns The render container, observer delivery and cleanup without changing shared globals.
 */
export function intersectionFixture() {
    const target = new HappyDomWindow() as unknown as Window;
    const callbacks = new Map<Element, (visible: boolean) => void>();
    const roots = new Map<Element, Element | Document | null>();
    Object.defineProperty(target, "IntersectionObserver", {
        configurable: true,
        value: class implements IntersectionObserver {
            readonly root: Element | Document | null;
            readonly rootMargin = "200px 0px";
            readonly scrollMargin = "0px";
            readonly thresholds = [0];
            readonly #callback: IntersectionObserverCallback;
            readonly #elements = new Set<Element>();
            /** Capture this observer's callback in its isolated window. */
            constructor(
                callback: IntersectionObserverCallback,
                options?: IntersectionObserverInit
            ) {
                this.#callback = callback;
                this.root = options?.root ?? null;
            }
            /** Register a sentinel for explicitly delivered visibility. */
            observe(element: Element) {
                this.#elements.add(element);
                roots.set(element, this.root);
                callbacks.set(element, (visible) =>
                    this.#callback(
                        [
                            {
                                target: element,
                                isIntersecting: visible,
                                intersectionRatio: visible ? 1 : 0,
                                time: 0,
                                boundingClientRect: element.getBoundingClientRect(),
                                intersectionRect: element.getBoundingClientRect(),
                                rootBounds: null,
                            },
                        ],
                        this
                    )
                );
            }
            /** Detach one sentinel. */
            unobserve(element: Element) {
                callbacks.delete(element);
                roots.delete(element);
                this.#elements.delete(element);
            }
            /** Detach all sentinels owned by this observer. */
            disconnect() {
                for (const element of this.#elements) {
                    callbacks.delete(element);
                    roots.delete(element);
                }
                this.#elements.clear();
            }
            /**
             * Read records not already delivered by the fixture.
             * @returns An empty list because delivery is explicitly controlled.
             */
            takeRecords(): IntersectionObserverEntry[] {
                return [];
            }
        },
    });
    return {
        container: target.document.body,
        observed() {
            return [...roots.entries()].map(([element, root]) => ({ element, root }));
        },
        intersect(visible = true) {
            for (const callback of callbacks.values()) callback(visible);
        },
        close() {
            target.close();
        },
    };
}
