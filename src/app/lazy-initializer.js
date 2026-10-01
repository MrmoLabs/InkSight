export function createLazyInitializer(initialize) {
    let initializationPromise = null;

    return (...args) => {
        if (!initializationPromise) {
            initializationPromise = Promise.resolve()
                .then(() => initialize(...args))
                .catch((error) => {
                    initializationPromise = null;
                    throw error;
                });
        }

        return initializationPromise;
    };
}
