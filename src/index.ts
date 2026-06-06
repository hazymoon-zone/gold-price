import { z } from "zod";

const ZGoldPrice = z.object({
	success: z.boolean(),
	timestamp: z.number(),
	date: z.string(),
	time: z.string(),
	type: z.string(),
	buy: z.number(),
	sell: z.number(),
});

interface Env {
	GOLD_PRICE: KVNamespace;
	MAILGUN_API_KEY: string;
	MAILGUN_SANDBOX: string;
}

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		url.pathname = "/__scheduled";
		url.searchParams.append("cron", "* * * * *");

		await process(env);

		return new Response(
			`To test the scheduled handler, ensure you have used the "--test-scheduled" then try running "curl ${url.href}".`,
		);
	},

	// The scheduled handler is invoked at the interval set in our wrangler.jsonc's
	// [[triggers]] configuration.
	async scheduled(_event, env, _ctx): Promise<void> {
		await process(env);
	},
} satisfies ExportedHandler<Env>;

async function process(env: Env) {
	await updateGoldPrice(env);

	const keyResult = await env.GOLD_PRICE.list();
	const keys = keyResult.keys
		.map((key) => key.name)
		.filter((key) => key !== "most-recent-key");
	keys.sort().reverse();
	if (keys.length < 2) return;

	const currentMostRecentKey = keys[0];
	const previousMostRecentKey = await env.GOLD_PRICE.get("most-recent-key");

	// No new gold price data since last check
	if (currentMostRecentKey === previousMostRecentKey) {
		console.log("No new gold price data since last check");
		return;
	}

	try {
		const goldPriceDownTrend = await getGoldPriceDownTrend(env, keys);
		if (goldPriceDownTrend?.length < 2) {
			console.log("No gold price downtrend detected");
			return;
		}

		console.log(`Gold price down trend: ${goldPriceDownTrend}`);

		const hitLimit = checkHitLimitReduction(goldPriceDownTrend);
		if (!hitLimit) {
			console.log("Hit limit not reached");
			return;
		}

		console.log(`Hit limit reached: ${hitLimit}`);

		await sendAlertEmail(env, goldPriceDownTrend);
	} finally {
		await env.GOLD_PRICE.put("most-recent-key", currentMostRecentKey);
	}
}

async function updateGoldPrice(env: Env) {
	const url = new URL("https://www.vang.today/api/prices?type=VNGSJC");
	const res = await fetch(url);
	if (!res.ok) {
		console.error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
		return;
	}
	const data = await res.json();
	const goldPriceData = ZGoldPrice.parse(data);
	const key = `${goldPriceData.date} ${goldPriceData.time}`;
	env.GOLD_PRICE.put(key, `${goldPriceData.sell}`, {
		expirationTtl: 604800, // 7 days
	});
}

async function getGoldPriceDownTrend(
	env: Env,
	keys: string[],
): Promise<number[]> {
	const goldPrices = [];
	for (const key of keys) {
		const priceStr = await env.GOLD_PRICE.get(key);
		if (!priceStr) continue;

		const price = Number(priceStr);
		if (goldPrices.length === 0) {
			goldPrices.push(price);
			continue;
		}

		if (goldPrices.includes(price)) continue;

		const lastPrice = goldPrices[goldPrices.length - 1];
		if (price <= lastPrice) {
			break;
		}

		goldPrices.push(price);
	}

	return goldPrices;
}

function calcReduction(goldPriceDownTrend: number[]): number {
	const mostRecentGoldPrice = goldPriceDownTrend[0];
	const leastRecentGoldPrice = goldPriceDownTrend.slice(-1)[0];
	const reduction =
		((leastRecentGoldPrice - mostRecentGoldPrice) / leastRecentGoldPrice) * 100;

	return reduction;
}

function checkHitLimitReduction(goldPriceDownTrend: number[]): boolean {
	const reduction = calcReduction(goldPriceDownTrend);

	return reduction >= 1;
}

async function sendAlertEmail(env: Env, goldPriceDownTrend: number[]) {
	const mostRecentGoldPrice = goldPriceDownTrend[0];
	const leastRecentGoldPrice = goldPriceDownTrend.slice(-1)[0];
	const reduction = calcReduction(goldPriceDownTrend);
	const reductionStr = reduction.toFixed(2);

	const form = new FormData();
	form.append("from", `Mailgun Sandbox <postmaster@${env.MAILGUN_SANDBOX}>`);
	form.append("to", "Huy Bui <huybui150396@gmail.com>");
	form.append("subject", `Gold price dips ${reductionStr}%`);
	form.append(
		"text",
		`Attention! Gold price dips ${reductionStr}% since last check. Previous: ${leastRecentGoldPrice}. Current: ${mostRecentGoldPrice}`,
	);
	const auth = btoa(`api:${env.MAILGUN_API_KEY}`);
	try {
		const response = await fetch(
			`https://api.mailgun.net/v3/${env.MAILGUN_SANDBOX}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Basic ${auth}`,
				},
				body: form,
			},
		);
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Mailgun error: ${error}`);
		}
	} catch (error) {
		console.error(error); //logs any error
		throw error;
	}
}
