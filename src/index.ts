import type { CreateChatCompletionRequest } from 'openai';

export type OnTextCallback = (text: string) => Promise<void> | undefined;

import { throttle } from './throttle';

interface StreamCompletionArgs {
	apiKey: string;
	args: CreateChatCompletionRequest;
	onText: OnTextCallback;
	throttleMs?: number;
}

/**
 * Stream a completion from OpenAI.
 */
export const streamCompletion = async ({
	apiKey,
	args,
	onText,
	throttleMs,
}: StreamCompletionArgs): Promise<string> => {
	// throttle callback?
	const handler = throttleMs ? throttle(throttleMs, onText, {}) : onText;

	// stream the completion
	return await _streamCompletion(apiKey, args, handler);
};

const _streamCompletion = async (
	token: string,
	args: CreateChatCompletionRequest,
	onText: OnTextCallback
) => {
	const response = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			...args,
			prompt: args.messages.map((message) => `${message.role}: ${message.content}`).join('\n'),
			stream: true,
		}),
	});
	if (!response.ok || !response.body) {
		console.error('OpenAI stream failed', response);
		console.error(await response.text());
		throw new Error('OpenAI stream failed');
	}

	const decoder = new TextDecoder('utf8');
	const reader = response.body.getReader();

	let fullText = '';

	async function readMore() {
		const { value, done } = await reader.read();

		if (done) {
			await onText(fullText);
		} else {
			const str = decoder.decode(value);

			// split on newlines
			const lines = str.split(/(\r\n|\r|\n)/g);

			const beforeText = fullText;

			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}

				let prefix;
				if (line.startsWith('data:')) {
					prefix = 'data:';
				} else if (line.startsWith('delta:')) {
					prefix = 'delta:';
				} else {
					console.error('Unexpected response from OpenAI stream, line=', line);
					throw new Error('Unexpected response from OpenAI stream, line=' + line);
				}

				const data = line.slice(prefix.length);
				if (data.trim().startsWith('[DONE]')) {
					return;
				}

				let json;
				try {
					json = JSON.parse(data);
				} catch (error) {
					console.error('Unexpected response from OpenAI stream, data=', data);
					throw error;
				}

				if (json.content) {
					fullText += json.content;
				} else if (json.choices) {
					fullText += json.choices[0].text;
				} else {
					console.warn('Unexpected response from OpenAI stream, json=', json);
				}
			}

			if (beforeText !== fullText) {
				await onText(fullText);
			}

			await readMore();
		}
	}

	await readMore();

	return fullText;
};
