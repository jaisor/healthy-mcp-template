import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import pkg from "../package.json";
import { createFoodApiClients } from "./foodapis";
import { isAllowed } from "./allowlist";
import { AuthHandler } from "./auth-handler";
import type { Props } from "./utils";
import { registerTools } from "./tools";

// Tools live in src/tools/.
// The user identity comes from the OAuth token (getMcpAuthContext); no tool ever accepts user_id.
const INSTRUCTIONS = [
	"A private food, water and workout log. Amounts are in grams (water in ml).",
	"To log food: search_foods, then (if the result is not saved) import_food, then log_entries with the food_id and grams or servings.",
	"Never calculate nutrient totals yourself: the server does it. If a food is not found, ask for its label values and use add_food. Every label nutrient is required: estimate only a value that is not listed, and then use source estimate (or fill when importing).",
	"Pass the date or time the user states (date, or eaten_at with an offset); otherwise it defaults to now.",
	"Send a new client_request_id with each log_entries and log_workout, and re-send the same one if you retry.",
	"Water: log_entries with water_ml.",
	"Use get_day to see a day (it gives the log_ids and workout_ids needed to change or archive entries). Nothing is ever deleted; archive_log and archive_workout hide an entry.",
	"For totals, trends, target adherence, top foods and workouts over a week, month or more, use get_report (the server computes everything: never add numbers up yourself); use get_top_foods for the foods that contribute most of one metric (top sources of protein, sugar, sodium, calories, or the most-eaten foods); use get_day to see the individual foods of one day.",
	"When the user asks for a dashboard, report, overview, summary, scorecard, tracker, progress page, chart or graph of their week, or any visual summary, call how_to_build_dashboard first, follow it, and build the result as an artifact (or your client's canvas, preview or page) when you can. A bare request like \"I want a report\" means a page, not text. Answer in text only when the question has a specific short answer (\"how many calories yesterday?\"). To say which version of this server is running, call get_server_version.",
	"Daily target metrics are saved with set_daily_target_metrics, read with get_daily_target_metrics, and stopped with archive_daily_target_metric (never send null). If a target tool says setup_complete is false, answer the question first, then ask once for the missing targets (say what the user gains), and never invent a value. (get_report fails until every required target is set: ask for the missing ones it names, save them, and call it again.) (workout_kcal_burned is optional and is never asked for.)",
	"If days land on the wrong date, call update_settings to set the user's time_zone.",
	"If a tool you expect from this server (for example add_food) is missing, or a call fails with a sign-in or authorization error, tell the user: \"healthy needs you to sign in again. Reconnect it in the connector settings.\" Do not say the tool is unavailable or not working.",
].join(" ");

function createServer() {
	const server = new McpServer({ name: pkg.name, version: pkg.version }, { instructions: INSTRUCTIONS });

	// The user comes from the validated OAuth token, never from tool input. Without one there is nothing safe to serve.
	const props = getMcpAuthContext()?.props as Props | undefined;
	if (!props?.userId) throw new Error("No signed-in user on this request.");
	registerTools(server, { userId: props.userId, db: env.DB, clients: createFoodApiClients(env.USDA_API_KEY), commit: env.GIT_SHA });

	return server;
}

const mcpHandler = createMcpHandler(createServer);
const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		// The allowlist is checked on every request, so removing someone from config/allowed-users.json
		// (and deploying) cuts off their existing tokens too. Tokens with neither a GitHub id nor a Google email are refused.
		const props = (ctx as { props?: Partial<Props> }).props;
		const identity = props?.githubId !== undefined ? { githubId: props.githubId } : props?.googleEmail !== undefined ? { googleEmail: props.googleEmail } : {};
		if (!isAllowed(identity)) {
			return Promise.resolve(Response.json({ error: "forbidden", error_description: "This server is private." }, { status: 403 }));
		}
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

const provider = new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: AuthHandler as any,
	tokenEndpoint: "/token",
	// The URL MCP clients connect to. Every token is bound to it.
	resourceMetadata: { resource: env.MCP_RESOURCE },
});

// Strangers can reach /register, /authorize, /token and the callbacks without signing in, so they are rate limited per IP address.
const LIMITED_PATHS = new Set(["/register", "/authorize", "/token", "/callback", "/callback/google"]);
export default {
	async fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		if (LIMITED_PATHS.has(new URL(request.url).pathname)) {
			const ip = request.headers.get("cf-connecting-ip");
			if (!ip) return new Response("Bad request", { status: 400 }); // Cloudflare always sets it
			const { success } = await bindings.AUTH_LIMIT.limit({ key: ip });
			if (!success) return new Response("Too many requests. Try again in a minute.", { status: 429, headers: { "Retry-After": "60" } });
		}
		return provider.fetch(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;
