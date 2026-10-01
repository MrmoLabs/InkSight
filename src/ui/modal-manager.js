import { t } from '../i18n/index.js';

export class ModalManager {
    constructor() {
        this.createModal();
    }

    createModal() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'modal-overlay';

        this.content = document.createElement('div');
        this.content.className = 'modal-content';

        this.closeBtn = document.createElement('button');
        this.closeBtn.className = 'modal-close';
        this.closeBtn.innerHTML = '&times;';
        this.closeBtn.onclick = () => this.hide();

        this.body = document.createElement('div');
        this.body.className = 'modal-body';

        this.content.appendChild(this.closeBtn);
        this.content.appendChild(this.body);
        this.overlay.appendChild(this.content);
        document.body.appendChild(this.overlay);

        // Close on click outside
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.hide();
            }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                // 确认/输入弹窗优先消费 Escape，避免叠加弹窗被一并关闭
                e.stopImmediatePropagation();
                this.hide();
            }
        });
    }

    showImage(src) {
        this.body.innerHTML = '';
        const img = document.createElement('img');
        img.src = src;
        img.className = 'modal-image';
        this.body.appendChild(img);
        this.show();
    }

    showText(text) {
        this.body.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'modal-text';
        div.textContent = text;
        this.body.appendChild(div);
        this.show();
    }

    showReaderAiResult({ title, passage, answer, saveLabel, mapLabel, closeLabel, onSave, onCreateMap }) {
        this.body.innerHTML = '';

        const heading = document.createElement('h3');
        heading.className = 'modal-title';
        heading.textContent = title;
        this.body.appendChild(heading);

        const source = document.createElement('blockquote');
        source.className = 'modal-message reader-ai-source';
        source.textContent = passage;
        this.body.appendChild(source);

        const result = document.createElement('div');
        result.className = 'modal-text';
        result.textContent = answer;
        this.body.appendChild(result);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        const addAction = (label, handler, primary = false) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `modal-btn${primary ? ' modal-btn-primary' : ''}`;
            button.textContent = label;
            button.onclick = () => {
                this.hide();
                handler?.();
            };
            actions.appendChild(button);
        };

        if (onSave) addAction(saveLabel, onSave);
        if (onCreateMap) addAction(mapLabel, onCreateMap, true);
        addAction(closeLabel, null);
        this.body.appendChild(actions);
        this.show();
    }

    /**
     * In-app replacement for window.confirm. Resolves true only when the
     * confirm button is pressed; cancel, backdrop click and Escape all
     * resolve false.
     */
    confirm({ title = '', message = '', confirmLabel, cancelLabel, danger = false } = {}) {
        confirmLabel = confirmLabel ?? t('common.confirm');
        cancelLabel = cancelLabel ?? t('common.cancel');
        return new Promise((resolve) => {
            this.body.innerHTML = '';

            if (title) {
                const heading = document.createElement('h3');
                heading.className = 'modal-title';
                heading.textContent = title;
                this.body.appendChild(heading);
            }

            if (message) {
                const text = document.createElement('p');
                text.className = 'modal-message';
                text.textContent = message;
                this.body.appendChild(text);
            }

            const actions = document.createElement('div');
            actions.className = 'modal-actions';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'modal-btn';
            cancelBtn.textContent = cancelLabel;

            const confirmBtn = document.createElement('button');
            confirmBtn.type = 'button';
            confirmBtn.className = `modal-btn modal-btn-primary${danger ? ' danger' : ''}`;
            confirmBtn.textContent = confirmLabel;

            actions.appendChild(cancelBtn);
            actions.appendChild(confirmBtn);
            this.body.appendChild(actions);

            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                this._confirmFinish = null;
                resolve(value);
                this.hide();
            };

            cancelBtn.onclick = () => finish(false);
            confirmBtn.onclick = () => finish(true);
            this._confirmFinish = finish;

            // 可能从设置弹窗等更高层弹窗中触发，必须压过所有现有遮罩
            this.overlay.classList.add('modal-overlay--top');
            this.show();
            confirmBtn.focus();
        });
    }

    /**
     * Single-line text input dialog. Resolves the trimmed input (possibly an
     * empty string) on confirm, or null on cancel.
     */
    prompt({ title = '', message = '', placeholder = '', initialValue = '', confirmLabel, cancelLabel } = {}) {
        confirmLabel = confirmLabel ?? t('common.confirm');
        cancelLabel = cancelLabel ?? t('common.cancel');
        return new Promise((resolve) => {
            this.body.innerHTML = '';

            if (title) {
                const heading = document.createElement('h3');
                heading.className = 'modal-title';
                heading.textContent = title;
                this.body.appendChild(heading);
            }

            if (message) {
                const text = document.createElement('p');
                text.className = 'modal-message';
                text.textContent = message;
                this.body.appendChild(text);
            }

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'modal-input';
            input.placeholder = placeholder;
            input.value = initialValue || '';

            const actions = document.createElement('div');
            actions.className = 'modal-actions';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'modal-btn';
            cancelBtn.textContent = cancelLabel;

            const confirmBtn = document.createElement('button');
            confirmBtn.type = 'button';
            confirmBtn.className = 'modal-btn modal-btn-primary';
            confirmBtn.textContent = confirmLabel;

            actions.appendChild(cancelBtn);
            actions.appendChild(confirmBtn);
            this.body.appendChild(input);
            this.body.appendChild(actions);

            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                this._confirmFinish = null;
                resolve(value);
                this.hide();
            };

            cancelBtn.onclick = () => finish(null);
            confirmBtn.onclick = () => finish(input.value.trim());
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    finish(input.value.trim());
                }
            });
            this._confirmFinish = finish;

            // 可能从设置弹窗等更高层弹窗中触发，必须压过所有现有遮罩
            this.overlay.classList.add('modal-overlay--top');
            this.show();
            input.focus();
        });
    }

    show() {
        this.isVisible = true;
        this.overlay.classList.add('active');
    }

    hide() {
        this.isVisible = false;
        this.overlay.classList.remove('active');
        this.overlay.classList.remove('modal-overlay--top');
        if (this._confirmFinish) {
            const finish = this._confirmFinish;
            this._confirmFinish = null;
            finish(false);
        }
    }
}

export const modalManager = new ModalManager();
