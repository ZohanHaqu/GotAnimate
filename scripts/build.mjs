import { context } from "esbuild";
import { join } from "path";
import { readFileSync } from "fs";
import { spawn } from "child_process";
import viteConfig from "../vite.config.js";

const DEV_HOST = "http://localhost";
const DEV_PORT = viteConfig.server.port || 5173;

/** @returns {Record<string, string>} */
const readEnv = () => {
	const env = JSON.parse(readFileSync(join(import.meta.dirname, "../config.json")));
	let envObj = {}
	for (const [key, val] of Object.entries(env)) {
		envObj["process.env." + key] = `'${val}'`;
	}
	return envObj;
};

/** @returns {import("esbuild").Plugin} */
const restartMainPlugin = (cb) => {
	return {
		name: "restart-main",
		setup(build) {
			build.onEnd(result => {
				console.log(`Main build ended with ${result.errors.length} errors`);
				cb();
			});
		},
	};
};

const BASE_OPTIONS = {
	bundle: true,
	external: [
		"@ffmpeg-installer/ffmpeg",
		"@ffprobe-installer/ffprobe",
		"electron",
		"es6-promise",
		"formidable",
	],
	platform: "node",
	target: "node14",
};

/** @type {Record<string, import("esbuild").BuildOptions>} */
let options = {
	main: {
		...BASE_OPTIONS,
		define: readEnv(),
		entryPoints: ["src/main/index.ts"],
		outfile: "dist/main.js",
	},
	preload: {
		...BASE_OPTIONS,
		entryPoints: ["src/preload.js"],
		outfile: "dist/preload.js",
	},
};

class ProcController {
	#procOptions = {
		main: [
			"npx",
			"electron",
			options.main.outfile,
			"--dev=true",
			`--host=${DEV_HOST}`,
			`--port=${DEV_PORT}`,
		]
	}
	/** @type {import("child_process").ChildProcessWithoutNullStreams | void} */
	mainProcess;
	restartMain() {
		if (this.mainProcess) {
			this.mainProcess.kill();
		}
		const prog = this.#procOptions["main"].at(0);
		const options = this.#procOptions["main"].slice(1);
		this.mainProcess = spawn(prog, options, {
			cwd: join(import.meta.dirname, "../"),
			stdio: ['inherit', 'inherit', 'inherit', 'inherit']
		});
		// this.mainProcess.stdout.on("data", (c) => console.log(c.toString()));
		// this.mainProcess.stderr.on("data", (c) => console.error(c.toString()));
	}
};

async function initContexts() {
	return {
		main: await context(options.main),
		preload: await context(options.preload)
	};
}

if (process.argv.includes("--dev")) {
	const controller = new ProcController(); 
	options.main.plugins = [
		restartMainPlugin(() => controller.restartMain())
	];
	let contexts = await initContexts();
	for (const [, ctx] of Object.entries(contexts)) {
		await ctx.watch()
	}
} else {
	let contexts = await initContexts();
	for (const [, ctx] of Object.entries(contexts)) {
		await ctx.rebuild();
		await ctx.dispose();
	}
}
