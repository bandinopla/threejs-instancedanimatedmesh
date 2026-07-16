import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
	base: "/threejs-instancedanimatedmesh/",
	root: path.resolve(__dirname, "demo"),
	resolve: {
		alias: {
			"threejs-instancedanimatedmesh": path.resolve(
				__dirname,
				"src/index.ts",
			),
		},
	},
	build: {
		outDir: path.resolve(__dirname, "dist-demo"),
		emptyOutDir: true,
	},
	server: {
		port: 3000,
		open: false,
	},
});
