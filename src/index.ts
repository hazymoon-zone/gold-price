import { DateTime } from "luxon";
import { z } from "zod";

const ZGoldPriceObject = z.record(z.string(), z.string());
const ZGoldPriceData = z.object({
	Data: z.array(ZGoldPriceObject),
});
const ZGoldPriceDataList = z.object({
	DataList: ZGoldPriceData,
});

interface Env {
	GOLD_PRICE: KVNamespace;
	MAILGUN_API_KEY: string;
	MAILGUN_SANDBOX: string;
}

type RecentGoldPrices = {
	secondRecentPrice: number;
	mostRecentPrice: number;
};

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
	const recentGoldPrices = await getRecentGoldPrices(env);
	if (!recentGoldPrices) return;

	const hitLimit = checkHitLimitReduction(recentGoldPrices);
	if (!hitLimit) return;

	await sendAlertEmail(env, recentGoldPrices);
}

async function updateGoldPrice(env: Env) {
	const url = new URL(
		"http://api.btmc.vn/api/BTMCAPI/getpricebtmc?key=3kd8ub1llcg9t45hnoh8hmn7t5kc2v",
	);
	const res = await fetch(url);
	if (!res.ok) {
		console.error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
		return;
	}
	const data = await res.json();
	const goldPriceData = ZGoldPriceDataList.parse(data);
	const goldPriceObjects = goldPriceData.DataList.Data;
	const ITEM = "NHẪN TRÒN TRƠN (Vàng Rồng Thăng Long)";
	for (const goldPriceObject of goldPriceObjects) {
		if (!goldPriceObject["@row"]) continue;
		const row = goldPriceObject["@row"];

		if (!goldPriceObject[`@n_${row}`]) continue;
		const name = goldPriceObject[`@n_${row}`];
		if (name.toLowerCase() !== ITEM.toLowerCase()) continue;

		if (!goldPriceObject[`@ps_${row}`]) continue;
		const priceSell = goldPriceObject[`@ps_${row}`];

		if (!goldPriceObject[`@d_${row}`]) continue;
		const dateString = goldPriceObject[`@d_${row}`];
		const date = DateTime.fromFormat(dateString, "dd/MM/yyyy HH:mm");
		const dateISO = date.toISO();
		if (!dateISO) continue;

		env.GOLD_PRICE.put(dateISO, priceSell, {
			expirationTtl: 604800, // 7 days
		});
	}
}

async function getRecentGoldPrices(env: Env): Promise<RecentGoldPrices | null> {
	const result = await env.GOLD_PRICE.list();
	const keys = result.keys;
	if (keys.length < 2) return null;

	const sortedKeys = keys.sort(
		(prev, next) =>
			DateTime.fromISO(prev.name).toMillis() -
			DateTime.fromISO(next.name).toMillis(),
	);

	const lastTwoKeys = sortedKeys.slice(sortedKeys.length - 2);
	const secondRecentKey = lastTwoKeys[0];
	const mostRecentKey = lastTwoKeys[1];

	const secondRecentPriceStr = await env.GOLD_PRICE.get(secondRecentKey.name);
	const mostRecentPriceStr = await env.GOLD_PRICE.get(mostRecentKey.name);

	if (!mostRecentPriceStr || !secondRecentPriceStr) return null;

	const secondRecentPrice = Number(secondRecentPriceStr);
	const mostRecentPrice = Number(mostRecentPriceStr);

	return { secondRecentPrice, mostRecentPrice };
}

function calcReduction(recentGoldPrices: RecentGoldPrices): number {
	const { secondRecentPrice, mostRecentPrice } = recentGoldPrices;
	const reduction =
		((secondRecentPrice - mostRecentPrice) / secondRecentPrice) * 100;
	return Number(reduction.toFixed(2));
}

function checkHitLimitReduction(recentGoldPrices: RecentGoldPrices): boolean {
	const { secondRecentPrice, mostRecentPrice } = recentGoldPrices;
	if (mostRecentPrice >= secondRecentPrice) return false;

	const reduction = calcReduction(recentGoldPrices);
	if (reduction < 1) return false;

	return true;
}

async function sendAlertEmail(env: Env, recentGoldPrices: RecentGoldPrices) {
	const { secondRecentPrice, mostRecentPrice } = recentGoldPrices;
	const reduction = calcReduction(recentGoldPrices);
	const form = new FormData();
	form.append("from", `Mailgun Sandbox <postmaster@${env.MAILGUN_SANDBOX}>`);
	form.append("to", "Huy Bui <huybui150396@gmail.com>");
	form.append("subject", `Gold price dips ${reduction}%`);
	form.append(
		"text",
		`Attention! Gold price dips ${reduction}% since last check. Previous: ${secondRecentPrice}. Current: ${mostRecentPrice}`,
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
			console.error("Mailgun error", await response.text());
		}
	} catch (error) {
		console.error(error); //logs any error
	}
}
