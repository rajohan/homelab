/**
 * Provide a per-test browser realm with manually delivered intersection observations.
 * @returns The render container, observer delivery and cleanup without changing shared globals.
 */
export function intersectionFixture() {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const target = frame.contentWindow;
    if (!target) throw new Error("Expected a test frame window");
    const callbacks = new Map<Element, () => void>();
    Object.defineProperty(target, "IntersectionObserver", {
        configurable: true,
        value: class implements IntersectionObserver {
            readonly root = null;
            readonly rootMargin = "200px 0px";
            readonly scrollMargin = "0px";
            readonly thresholds = [0];
            readonly #callback: IntersectionObserverCallback;
            readonly #elements = new Set<Element>();
            /** Capture this observer's callback in its isolated frame. */
            constructor(callback: IntersectionObserverCallback) {
                this.#callback = callback;
            }
            /** Register a sentinel for explicitly delivered visibility. */
            observe(element: Element) {
                this.#elements.add(element);
                callbacks.set(element, () =>
                    this.#callback(
                        [
                            {
                                target: element,
                                isIntersecting: true,
                                intersectionRatio: 1,
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
                this.#elements.delete(element);
            }
            /** Detach all sentinels owned by this observer. */
            disconnect() {
                for (const element of this.#elements) callbacks.delete(element);
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
        intersect() {
            for (const callback of callbacks.values()) callback();
        },
        close() {
            frame.remove();
        },
    };
}
