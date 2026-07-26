import { createNodeRspackConfig } from '../../scripts/create-node-rspack-config.mjs';

const config = createNodeRspackConfig(import.meta.url);
config.externals = {
	...config.externals,
	'node-gtk': 'commonjs node-gtk',
};

export default config;
