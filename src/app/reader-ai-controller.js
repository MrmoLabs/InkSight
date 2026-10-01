import { t } from '../i18n/index.js';

const ACTIONS = Object.freeze(['explain', 'summarize']);

export function buildReaderAiMessages(action, passage) {
    if (!ACTIONS.includes(action)) {
        throw new Error(`Unsupported reader AI action: ${action}`);
    }

    const instruction = action === 'explain'
        ? t('readerAI.prompt.explain')
        : t('readerAI.prompt.summarize');

    return [{
        role: 'user',
        content: `${instruction}\n\n${t('readerAI.passageLabel')}:\n${passage}`
    }];
}

export function createReaderAiController({
    getPassage,
    aiConfigManager,
    chatComplete,
    confirmSend,
    showResult,
    notify
}) {
    return {
        async run(action) {
            if (!ACTIONS.includes(action)) {
                return false;
            }

            const passage = getPassage?.();
            if (!passage?.text?.trim()) {
                notify({ message: t('readerAI.noPassage'), level: 'warning' });
                return false;
            }

            if (!aiConfigManager.isConfigured()) {
                notify({ message: t('readerAI.notConfigured'), level: 'warning' });
                return false;
            }

            const config = aiConfigManager.get();
            const presets = aiConfigManager.getPresets?.() ?? {};
            const review = {
                action,
                provider: presets[config.provider]?.label || config.provider,
                endpoint: config.baseUrl,
                model: config.model,
                passage: passage.text.trim()
            };

            if (!await confirmSend(review)) {
                return false;
            }

            try {
                const answer = await chatComplete(config, {
                    system: t('readerAI.system'),
                    messages: buildReaderAiMessages(action, review.passage)
                });
                showResult({ action, answer, passage });
                return true;
            } catch (error) {
                notify({
                    message: t('readerAI.requestFailed', { message: error.message }),
                    level: 'error'
                });
                return false;
            }
        }
    };
}
