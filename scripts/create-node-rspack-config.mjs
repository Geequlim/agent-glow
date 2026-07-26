import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TsCheckerRspackPlugin } from 'ts-checker-rspack-plugin';

export function createNodeRspackConfig(configUrl) {
	const directory = path.dirname(fileURLToPath(configUrl));

	return {
		context: directory,
		entry: {
			index: './src/index.ts',
		},
		target: 'node',
		mode: 'production',
		devtool: 'source-map',
		externalsPresets: { node: true },
		externals: {
			'abstract-socket': 'commonjs abstract-socket',
		},
		module: {
			rules: [
				{
					test: /\.ts$/,
					exclude: /node_modules/,
					use: [
						{
							loader: 'builtin:swc-loader',
							options: {
								jsc: {
									parser: {
										syntax: 'typescript',
									},
									target: 'es2024',
								},
							},
						},
					],
				},
			],
		},
		resolve: {
			extensions: ['.ts', '.js'],
			extensionAlias: {
				'.js': ['.ts', '.js'],
			},
		},
		plugins: [
			new TsCheckerRspackPlugin({
				typescript: {
					configFile: path.join(directory, 'tsconfig.json'),
				},
			}),
		],
		output: {
			path: path.join(directory, 'dist'),
			filename: '[name].cjs',
			clean: true,
			devtoolModuleFilenameTemplate: (info) =>
				path.resolve(directory, info.resourcePath).split(path.sep).join('/'),
			library: {
				type: 'commonjs2',
			},
		},
	};
}
