import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { VisualProfile } from '@agent-glow/protocol/config';
import type { DeviceConfigurationSetting } from '@agent-glow/protocol/device-configuration';
import { autorun, type IReactionDisposer } from 'mobx';

import packageMetadata from '../package.json';

import type { DesktopApplication } from './application.js';
import {
	CONFIGURABLE_STATES,
	DesktopState,
	STATE_LABELS,
	type ConfigurableState,
} from './desktop-state.js';
import { Adw, Gdk, Gio, GLib, Gtk } from './gtk.js';
import type { IntegrationId, IntegrationPlan } from './integration-manager.js';
import type { AgentGlowRpcClient } from './rpc-client.js';
import { SocketAgentGlowRpcClient } from './rpc-client.js';

const APPLICATION_ID = 'io.github.geequlim.AgentGlow';
const APPLICATION_NAME = 'Agent Glow';
const ICON_PATH = path.resolve(import.meta.dirname, '../icon.png');
const ICON_DIRECTORY = path.resolve(import.meta.dirname, '../icons');

const pages = [
	{ id: 'overview', title: '概览', icon: 'view-grid-symbolic' },
	{ id: 'styles', title: '灯效', icon: 'applications-graphics-symbolic' },
	{ id: 'devices', title: '设备', icon: 'agent-glow-light-device-symbolic' },
	{ id: 'agents', title: '集成', icon: 'agent-glow-agent-symbolic' },
	{ id: 'about', title: '关于', icon: 'dialog-information-symbolic' },
] as const;

export function createGtkApplication(): DesktopApplication {
	GLib.setApplicationName(APPLICATION_NAME);
	const application = new Adw.Application({
		applicationId: APPLICATION_ID,
		flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
	});
	const state = new DesktopState();
	const rpc = new SocketAgentGlowRpcClient();
	return {
		onActivate: (listener) => application.on('activate', listener),
		getActiveWindow: () => application.getActiveWindow() ?? undefined,
		createWindow: () => createMainWindow(application, state, rpc),
		run: (args) => application.run([...args]),
	};
}

function createMainWindow(
	application: InstanceType<typeof Adw.Application>,
	state: DesktopState,
	rpc: AgentGlowRpcClient,
): InstanceType<typeof Adw.ApplicationWindow> {
	const display = Gdk.Display.getDefault();
	if (display) Gtk.IconTheme.getForDisplay(display).addSearchPath(ICON_DIRECTORY);
	Gtk.Window.setDefaultIconName(APPLICATION_ID);
	const disposers: IReactionDisposer[] = [];
	const navigation = new Gtk.ListBox({
		selectionMode: Gtk.SelectionMode.SINGLE,
		cssClasses: ['navigation-sidebar'],
	});
	const stack = new Adw.ViewStack({ hexpand: true, vexpand: true });
	const title = new Adw.WindowTitle({ title: '概览' });
	const rowPages = new Map<InstanceType<typeof Gtk.ListBoxRow>, string>();

	const factories: Record<string, () => InstanceType<typeof Gtk.Widget>> = {
		overview: () => createOverviewPage(state, disposers),
		styles: () => createStylesPage(state, rpc, application, disposers),
		devices: () => createDevicesPage(state, disposers),
		agents: () => createAgentsPage(state, disposers),
		about: () => createAboutPage(),
	};

	for (const page of pages) {
		const row = new Adw.ActionRow({ title: page.title, activatable: true });
		row.addPrefix(new Gtk.Image({ iconName: page.icon }));
		navigation.append(row);
		rowPages.set(row, page.id);
		stack.addNamed(factories[page.id](), page.id);
	}
	navigation.on('row-selected', () => {
		const row = navigation.getSelectedRow();
		const pageId = row ? rowPages.get(row) : undefined;
		const definition = pages.find((candidate) => candidate.id === pageId);
		if (!definition) return;
		stack.visibleChildName = definition.id;
		title.title = definition.title;
	});

	const sidebar = new Adw.ToolbarView({
		content: new Gtk.ScrolledWindow({ child: navigation, vexpand: true }),
	});
	sidebar.addTopBar(
		new Adw.HeaderBar({
			titleWidget: new Adw.WindowTitle({ title: APPLICATION_NAME, subtitle: '灯光状态' }),
		}),
	);
	const banner = new Adw.Banner({ revealed: false });
	const contentBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
	contentBox.append(banner);
	contentBox.append(stack);
	const content = new Adw.ToolbarView({ content: contentBox });
	content.addTopBar(new Adw.HeaderBar({ titleWidget: title }));
	const splitView = new Adw.NavigationSplitView({
		sidebar: new Adw.NavigationPage({ child: sidebar, title: APPLICATION_NAME }),
		content: new Adw.NavigationPage({ child: content, title: '设置' }),
		showContent: true,
		minSidebarWidth: 220,
		maxSidebarWidth: 280,
	});
	const window = new Adw.ApplicationWindow({
		application,
		content: splitView,
		defaultWidth: 1040,
		defaultHeight: 720,
		title: APPLICATION_NAME,
	});
	disposers.push(
		autorun(() => {
			banner.revealed = Boolean(state.error);
			banner.title = state.error ?? '';
		}),
	);
	navigation.selectRow(navigation.getRowAtIndex(0));
	void state.refresh();
	let closing = false;
	window.on('close-request', () => {
		if (closing) return true;
		closing = true;
		void state
			.flushPendingChanges()
			.catch(() => undefined)
			.then(() => {
				disposers.forEach((dispose) => dispose());
				window.destroy();
			});
		return true;
	});
	return window;
}

function createOverviewPage(
	state: DesktopState,
	disposers: IReactionDisposer[],
): InstanceType<typeof Adw.PreferencesPage> {
	const serviceRow = new Adw.SwitchRow({
		title: `启用 ${APPLICATION_NAME}`,
		subtitle: '同时控制后台服务与登录后自动启动。',
	});
	serviceRow.on('notify::active', () => {
		const enabled = state.service.enabled && state.service.running;
		if (!state.serviceBusy && serviceRow.active !== enabled)
			void state.setServiceEnabled(serviceRow.active);
	});
	const powerSavingRow = new Adw.SwitchRow({
		title: '省电模式',
		subtitle: '使用电池供电时暂停所有灯效。',
	});
	let syncingPowerSaving = false;
	powerSavingRow.on('notify::active', () => {
		if (!syncingPowerSaving && powerSavingRow.active !== state.config.daemon.powerSavingMode) {
			state.updatePowerSavingMode(powerSavingRow.active);
		}
	});
	const activityRow = new Adw.ActionRow({ title: '当前活动' });
	const deviceRow = new Adw.ActionRow({ title: '已发现设备' });
	const saveRow = new Adw.ActionRow({ title: '配置状态' });
	const backendRow = new Adw.ActionRow({ title: 'Backend' });
	const serviceEntryRow = new Adw.ActionRow({ title: '服务端程序' });
	const diagnosticRow = new Adw.ActionRow({ title: '诊断摘要' });
	const journalRow = new Adw.ActionRow({
		title: '服务日志',
		subtitle: 'journalctl --user-unit agent-glow.service -f',
	});
	const refreshButton = new Gtk.Button({
		label: '刷新',
		valign: Gtk.Align.CENTER,
	});
	refreshButton.on('clicked', () => void state.refresh());
	const refreshRow = new Adw.ActionRow({
		title: '重新读取状态',
		subtitle: '刷新服务、设备与诊断信息。',
	});
	refreshRow.addSuffix(refreshButton);
	const group = new Adw.PreferencesGroup({
		title: '运行状态',
		description: '所有设置修改都会自动生效。',
	});
	group.add(serviceRow);
	group.add(powerSavingRow);
	group.add(activityRow);
	group.add(deviceRow);
	group.add(saveRow);
	group.add(refreshRow);
	const exportButton = new Gtk.Button({
		label: '导出脱敏诊断',
		valign: Gtk.Align.CENTER,
	});
	const exportRow = new Adw.ActionRow({
		title: '诊断文件',
		subtitle: '导出内容不包含用户配置文件或密钥。',
	});
	exportRow.addSuffix(exportButton);
	exportButton.on('clicked', () => {
		const target = path.join(tmpdir(), 'agent-glow-diagnostics.json');
		void writeFile(
			target,
			`${JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					service: state.service,
					daemon: state.daemon,
					devices: state.devices,
					diagnostics: state.diagnostics,
				},
				null,
				2,
			)}\n`,
			'utf8',
		)
			.then(() => {
				const opened = Gio.AppInfo.launchDefaultForUri(
					Gio.File.newForPath(target).getUri(),
					null,
				);
				if (!opened) throw new Error('系统中没有可查看 JSON 文件的应用。');
				exportRow.subtitle = `已导出并打开 ${target}`;
			})
			.catch((error: unknown) => {
				exportRow.subtitle = error instanceof Error ? error.message : String(error);
			});
	});
	const diagnosticsGroup = new Adw.PreferencesGroup({ title: '诊断' });
	diagnosticsGroup.add(serviceEntryRow);
	diagnosticsGroup.add(backendRow);
	diagnosticsGroup.add(diagnosticRow);
	diagnosticsGroup.add(journalRow);
	diagnosticsGroup.add(exportRow);
	const page = new Adw.PreferencesPage({ title: '概览' });
	page.add(group);
	page.add(diagnosticsGroup);
	disposers.push(
		autorun(() => {
			serviceRow.active = state.service.enabled && state.service.running;
			serviceRow.sensitive = !state.serviceBusy;
			serviceRow.subtitle = state.serviceBusy
				? '正在更新服务状态…'
				: state.service.enabled === state.service.running
					? '同时控制后台服务与登录后自动启动。'
					: '服务状态不一致，切换一次即可统一修正。';
			syncingPowerSaving = true;
			powerSavingRow.active = state.config.daemon.powerSavingMode;
			powerSavingRow.sensitive = state.service.running && !state.configSaving;
			syncingPowerSaving = false;
			activityRow.subtitle = state.daemon
				? state.daemon.currentState === 'idle'
					? '当前没有活动任务'
					: stateLabel(state.daemon.currentState)
				: '服务未运行';
			deviceRow.subtitle = state.service.running
				? `${state.devices.length} 台设备`
				: '启动服务后读取';
			saveRow.subtitle = state.configSaving
				? '正在应用…'
				: state.lastSavedAt
					? '已自动应用'
					: '已加载';
			const diagnostics = state.diagnostics;
			serviceEntryRow.subtitle = diagnostics?.service.entryPath ?? '服务未连接';
			backendRow.subtitle = diagnostics?.backend
				? `${diagnostics.backend.id ?? 'unknown'} · ${diagnostics.backend.health ?? 'unknown'}`
				: '服务未连接';
			diagnosticRow.subtitle = `${state.devices.length} 台设备 · ${
				state.error ? '存在错误' : '未发现错误'
			}`;
		}),
	);
	return page;
}

function createStylesPage(
	state: DesktopState,
	rpc: AgentGlowRpcClient,
	application: InstanceType<typeof Adw.Application>,
	disposers: IReactionDisposer[],
): InstanceType<typeof Adw.PreferencesPage> {
	const page = new Adw.PreferencesPage({ title: '灯光样式' });
	const actionGroup = new Adw.PreferencesGroup({
		description: '颜色和动画参数修改后自动应用，无需保存。',
	});
	const previewButton = new Gtk.Button({ label: '打开预览', valign: Gtk.Align.CENTER });
	previewButton.on('clicked', () => createPreviewWindow(application, rpc));
	const resetButton = new Gtk.Button({ label: '恢复默认', valign: Gtk.Align.CENTER });
	const buttons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
	buttons.append(previewButton);
	buttons.append(resetButton);
	const actionRow = new Adw.ActionRow({ title: '预览与默认值' });
	actionRow.addSuffix(buttons);
	resetButton.on('clicked', () => {
		const confirmation = new Adw.AlertDialog({
			heading: '恢复全部灯光样式？',
			body: '六个任务阶段、最长保持时间和切换过渡将恢复为项目默认值，并立即应用。',
			closeResponse: 'cancel',
			defaultResponse: 'cancel',
		});
		confirmation.addResponse('cancel', '取消');
		confirmation.addResponse('reset', '恢复默认');
		confirmation.setResponseAppearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
		confirmation.choose(actionRow, null, (_source, result) => {
			if (confirmation.chooseFinish(result) === 'reset') state.restoreDefaultStyles();
		});
	});
	actionGroup.add(actionRow);
	const transition = createSpinRow('切换过渡', '毫秒', 0, 2000, 25, 0);
	let syncingTransition = false;
	transition.on('notify::value', () => {
		if (!syncingTransition) state.updateTransition(Math.round(transition.value));
	});
	actionGroup.add(transition);
	const retainedStateTimeout = createSpinRow(
		'成功、失败与暂停最长保持时间',
		'秒',
		1,
		86_400,
		1,
		0,
	);
	let syncingRetainedStateTimeout = false;
	retainedStateTimeout.on('notify::value', () => {
		if (!syncingRetainedStateTimeout) {
			state.updateRetainedStateTimeout(Math.round(retainedStateTimeout.value) * 1000);
		}
	});
	actionGroup.add(retainedStateTimeout);
	page.add(actionGroup);
	disposers.push(
		autorun(() => {
			syncingTransition = true;
			transition.value = state.config.rendering.transitionMs;
			syncingTransition = false;
			syncingRetainedStateTimeout = true;
			retainedStateTimeout.value = state.config.daemon.retainedStateTimeoutMs / 1000;
			syncingRetainedStateTimeout = false;
		}),
	);
	for (const semanticState of CONFIGURABLE_STATES) {
		page.add(createProfileGroup(state, semanticState, disposers));
	}
	return page;
}

function createProfileGroup(
	state: DesktopState,
	semanticState: ConfigurableState,
	disposers: IReactionDisposer[],
): InstanceType<typeof Adw.PreferencesGroup> {
	const color = new Gtk.ColorDialogButton({
		dialog: new Gtk.ColorDialog({
			title: `选择${STATE_LABELS[semanticState]}颜色`,
			modal: true,
			withAlpha: false,
		}),
		valign: Gtk.Align.CENTER,
	});
	const colorRow = new Adw.ActionRow({ title: '颜色' });
	colorRow.addSuffix(color);
	const startColor = new Gtk.ColorDialogButton({
		dialog: new Gtk.ColorDialog({
			title: `选择${STATE_LABELS[semanticState]}起始颜色`,
			modal: true,
			withAlpha: false,
		}),
		valign: Gtk.Align.CENTER,
	});
	const startColorRow = new Adw.ActionRow({ title: '起始颜色' });
	startColorRow.addSuffix(startColor);
	const endColor = new Gtk.ColorDialogButton({
		dialog: new Gtk.ColorDialog({
			title: `选择${STATE_LABELS[semanticState]}终止颜色`,
			modal: true,
			withAlpha: false,
		}),
		valign: Gtk.Align.CENTER,
	});
	const endColorRow = new Adw.ActionRow({ title: '终止颜色' });
	endColorRow.addSuffix(endColor);
	const effectModel = Gtk.StringList.new(['静态', '呼吸', '数据流', '脉冲']);
	const effect = new Adw.ComboRow({ title: '动画', model: effectModel });
	const minimumVisible = createSpinRow('最短展示时间', '毫秒', 0, 5000, 50, 0);
	const hardware = createSpinRow('硬件亮度', '0–100%', 0, 100, 1, 0);
	const intensity = createSpinRow('亮度', '0–100%', 0, 100, 1, 0);
	const minimum = createSpinRow('最低亮度', '0–100%', 0, 100, 1, 0);
	const maximum = createSpinRow('最高亮度', '0–100%', 0, 100, 1, 0);
	const period = createSpinRow('动画周期', '毫秒', 250, 10_000, 50, 0);
	const duration = createSpinRow('脉冲时长', '毫秒', 100, 10_000, 50, 0);
	const pulseCount = createSpinRow('脉冲次数', '1–4 次', 1, 4, 1, 0);
	const group = new Adw.PreferencesGroup({ title: STATE_LABELS[semanticState] });
	[
		effect,
		minimumVisible,
		colorRow,
		startColorRow,
		endColorRow,
		hardware,
		intensity,
		minimum,
		maximum,
		period,
		duration,
		pulseCount,
	].forEach((row) => group.add(row));
	let syncing = false;
	const submit = (): void => {
		if (syncing) return;
		const current = state.config.profiles[semanticState];
		const selectedEffect =
			(['static', 'breathe', 'stream', 'pulse'] as const)[effect.selected] ?? 'static';
		const common = {
			hardwareIntensity: hardware.value / 100,
			minimumVisibleMs: Math.round(minimumVisible.value),
		};
		const profile =
			selectedEffect === 'static'
				? {
						...common,
						color: rgbaToHex(color.rgba),
						effect: 'static',
						intensity: intensity.value / 100,
					}
				: selectedEffect === 'pulse'
					? {
							...common,
							startColor: rgbaToHex(startColor.rgba),
							endColor: rgbaToHex(endColor.rgba),
							effect: 'pulse',
							minimumIntensity: minimum.value / 100,
							maximumIntensity: maximum.value / 100,
							durationMs: Math.round(duration.value),
							pulseCount: Math.round(pulseCount.value),
						}
					: {
							...common,
							startColor: rgbaToHex(startColor.rgba),
							endColor: rgbaToHex(endColor.rgba),
							effect: selectedEffect,
							minimumIntensity: minimum.value / 100,
							maximumIntensity: maximum.value / 100,
							periodMs: Math.round(period.value),
						};
		if (JSON.stringify(profile) === JSON.stringify(current)) return;
		state.updateProfile(semanticState, profile as VisualProfile);
		setEffectRowsVisible(selectedEffect);
	};
	const setEffectRowsVisible = (selected: VisualProfile['effect']): void => {
		colorRow.visible = selected === 'static';
		startColorRow.visible = selected !== 'static';
		endColorRow.visible = selected !== 'static';
		intensity.visible = selected === 'static';
		minimum.visible = selected !== 'static';
		maximum.visible = selected !== 'static';
		period.visible = selected === 'breathe' || selected === 'stream';
		duration.visible = selected === 'pulse';
		pulseCount.visible = selected === 'pulse';
	};
	color.on('notify::rgba', submit);
	startColor.on('notify::rgba', submit);
	endColor.on('notify::rgba', submit);
	effect.on('notify::selected', submit);
	[minimumVisible, hardware, intensity, minimum, maximum, period, duration, pulseCount].forEach(
		(row) => row.on('notify::value', submit),
	);
	disposers.push(
		autorun(() => {
			const profile = state.config.profiles[semanticState];
			syncing = true;
			const primaryColor = profile.effect === 'static' ? profile.color : profile.endColor;
			const initialColor = profile.effect === 'static' ? profile.color : profile.startColor;
			color.rgba = parseRgba(primaryColor);
			colorRow.subtitle = primaryColor.toUpperCase();
			startColor.rgba = parseRgba(initialColor);
			startColorRow.subtitle = initialColor.toUpperCase();
			endColor.rgba = parseRgba(primaryColor);
			endColorRow.subtitle = primaryColor.toUpperCase();
			effect.selected = { static: 0, breathe: 1, stream: 2, pulse: 3 }[profile.effect];
			minimumVisible.value = profile.minimumVisibleMs;
			hardware.value = profile.hardwareIntensity * 100;
			intensity.value = profile.effect === 'static' ? profile.intensity * 100 : 100;
			minimum.value = profile.effect === 'static' ? 0 : profile.minimumIntensity * 100;
			maximum.value = profile.effect === 'static' ? 100 : profile.maximumIntensity * 100;
			period.value =
				profile.effect === 'breathe' || profile.effect === 'stream'
					? profile.periodMs
					: 2000;
			duration.value = profile.effect === 'pulse' ? profile.durationMs : 900;
			pulseCount.value = profile.effect === 'pulse' ? profile.pulseCount : 1;
			setEffectRowsVisible(profile.effect);
			syncing = false;
		}),
	);
	return group;
}

function createDevicesPage(
	state: DesktopState,
	disposers: IReactionDisposer[],
): InstanceType<typeof Adw.PreferencesPage> {
	const page = new Adw.PreferencesPage({ title: '设备' });
	let groups: InstanceType<typeof Adw.PreferencesGroup>[] = [];
	let signature = '';
	disposers.push(
		autorun(() => {
			const nextSignature = JSON.stringify(
				state.devices.map((device) => [
					device.id,
					state.deviceConfigurations.get(device.id),
				]),
			);
			if (nextSignature === signature) return;
			signature = nextSignature;
			groups.forEach((group) => page.remove(group));
			groups = [];
			if (state.devices.length === 0) {
				const empty = new Adw.PreferencesGroup({
					title: '尚未发现设备',
					description: state.service.running
						? '等待 backend 注册设备。'
						: `请先在概览页启用 ${APPLICATION_NAME}。`,
				});
				page.add(empty);
				groups.push(empty);
				return;
			}
			for (const device of state.devices) {
				const configuration = state.deviceConfigurations.get(device.id);
				const information = new Adw.PreferencesGroup({
					title: device.name,
					description: '设备信息',
				});
				const enabledSetting = configuration?.settings.find(
					(setting) => setting.key === 'enabled',
				);
				if (enabledSetting)
					information.add(
						createDeviceSettingRow(
							enabledSetting,
							configuration?.values[enabledSetting.key],
							(value) =>
								void state.updateDeviceSetting(
									device.id,
									enabledSetting.key,
									value,
								),
						),
					);
				if (device.description)
					information.add(
						new Adw.ActionRow({ title: '设备说明', subtitle: device.description }),
					);
				information.add(
					new Adw.ActionRow({
						title: '接入后端',
						subtitle: device.id.split(':', 1)[0] ?? '未知',
					}),
				);
				information.add(new Adw.ActionRow({ title: '设备标识', subtitle: device.id }));
				information.add(
					new Adw.ActionRow({
						title: '支持功能',
						subtitle: device.capabilities.map(deviceCapabilityLabel).join('、'),
					}),
				);
				page.add(information);
				groups.push(information);
				if (configuration) {
					const settingsByGroup = Map.groupBy(
						configuration.settings.filter((setting) => setting.key !== 'enabled'),
						(setting) => setting.group ?? '设备设置',
					);
					for (const [groupLabel, settings] of settingsByGroup) {
						const settingsGroup = new Adw.PreferencesGroup({
							title: `${device.name} · ${groupLabel}`,
						});
						for (const setting of settings)
							settingsGroup.add(
								createDeviceSettingRow(
									setting,
									configuration.values[setting.key],
									(value) =>
										void state.updateDeviceSetting(
											device.id,
											setting.key,
											value,
										),
								),
							);
						page.add(settingsGroup);
						groups.push(settingsGroup);
					}
				}
			}
		}),
	);
	return page;
}

function createDeviceSettingRow(
	setting: DeviceConfigurationSetting,
	value: boolean | number | string | undefined,
	update: (value: boolean | number | string) => void,
): InstanceType<typeof Gtk.Widget> {
	if (setting.kind === 'boolean') {
		const row = new Adw.SwitchRow({
			title: setting.label,
			subtitle: setting.description ?? '',
			active: typeof value === 'boolean' ? value : setting.defaultValue,
		});
		row.on('notify::active', () => update(row.active));
		return row;
	}
	if (setting.kind === 'integer') {
		const row = createSpinRow(
			setting.label,
			setting.description ?? '',
			setting.minimum,
			setting.maximum,
			setting.step,
			0,
		);
		row.value = typeof value === 'number' ? value : setting.defaultValue;
		row.on('notify::value', () => update(Math.round(row.value)));
		return row;
	}
	const model = Gtk.StringList.new(setting.options.map((option) => option.label));
	const row = new Adw.ComboRow({
		title: setting.label,
		subtitle: setting.description ?? '',
		model,
		selected: Math.max(
			0,
			setting.options.findIndex((option) => option.value === (value ?? setting.defaultValue)),
		),
	});
	row.on('notify::selected', () => {
		const option = setting.options[row.selected];
		if (option) update(option.value);
	});
	return row;
}

function createAgentsPage(
	state: DesktopState,
	disposers: IReactionDisposer[],
): InstanceType<typeof Adw.PreferencesPage> {
	const page = new Adw.PreferencesPage({ title: 'Agent 集成' });
	const group = new Adw.PreferencesGroup({
		title: '支持的 Agent',
		description: '安装前会展示目标文件和完整 diff，确认后才写入。',
	});
	const codex = new Adw.ActionRow({ title: 'Codex' });
	const opencode = new Adw.ActionRow({ title: 'OpenCode' });
	const zcode = new Adw.ActionRow({ title: 'ZCode' });
	const codexButton = new Gtk.Button({ valign: Gtk.Align.CENTER });
	const openCodeButton = new Gtk.Button({ valign: Gtk.Align.CENTER });
	const zcodeButton = new Gtk.Button({ valign: Gtk.Align.CENTER });
	codex.addSuffix(codexButton);
	opencode.addSuffix(openCodeButton);
	zcode.addSuffix(zcodeButton);
	const openPlan = (id: IntegrationId): void => {
		const detection = state.agents.find((agent) => agent.id === id);
		const action = detection?.updateAvailable || !detection?.connected ? 'install' : 'remove';
		const button =
			id === 'codex' ? codexButton : id === 'opencode' ? openCodeButton : zcodeButton;
		button.sensitive = false;
		button.label = '正在读取…';
		void state
			.planIntegration(id, action)
			.then((plan) => createIntegrationDiffDialog(page, state, plan))
			.catch((error: unknown) => {
				state.error = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				button.sensitive = detection?.available ?? false;
				button.label = integrationButtonLabel(detection);
			});
	};
	codexButton.on('clicked', () => openPlan('codex'));
	openCodeButton.on('clicked', () => openPlan('opencode'));
	zcodeButton.on('clicked', () => openPlan('zcode'));
	group.add(codex);
	group.add(opencode);
	group.add(zcode);
	page.add(group);
	disposers.push(
		autorun(() => {
			for (const [id, row] of [
				['codex', codex],
				['opencode', opencode],
				['zcode', zcode],
			] as const) {
				const detection = state.agents.find((agent) => agent.id === id);
				const button =
					id === 'codex' ? codexButton : id === 'opencode' ? openCodeButton : zcodeButton;
				button.label = integrationButtonLabel(detection);
				button.sensitive = detection?.available ?? false;
				row.subtitle = detection?.available
					? detection.connected
						? detection.updateAvailable
							? `发现 ${APPLICATION_NAME} 接入更新`
							: id === 'codex'
								? `已写入 Hook · 请在 Codex /hooks 中检查信任状态`
								: id === 'opencode'
									? '已安装全局插件 · 重启 OpenCode 后生效'
									: '已写入用户级 Hook · 新会话生效'
						: `已检测到${detection.version ? ` · ${detection.version}` : ''}`
					: '未检测到可执行程序';
			}
		}),
	);
	return page;
}

function integrationButtonLabel(
	detection:
		| {
				readonly connected: boolean;
				readonly updateAvailable: boolean;
		  }
		| undefined,
): string {
	if (detection?.updateAvailable) return '升级';
	return detection?.connected ? '移除' : '接入';
}

function createIntegrationDiffDialog(
	parent: InstanceType<typeof Gtk.Widget>,
	state: DesktopState,
	plan: IntegrationPlan,
): void {
	const buffer = new Gtk.TextBuffer({ text: plan.diff });
	const view = new Gtk.TextView({
		buffer,
		editable: false,
		monospace: true,
		cursorVisible: false,
		topMargin: 12,
		bottomMargin: 12,
		leftMargin: 12,
		rightMargin: 12,
	});
	const scroll = new Gtk.ScrolledWindow({ child: view, vexpand: true, hexpand: true });
	const pathLabel = new Gtk.Label({
		label: plan.targetPath,
		xalign: 0,
		selectable: true,
		cssClasses: ['dim-label'],
		marginTop: 8,
		marginBottom: 8,
		marginStart: 12,
		marginEnd: 12,
	});
	const cancel = new Gtk.Button({ label: '取消' });
	const apply = new Gtk.Button({
		label: plan.action === 'install' ? '确认接入' : '确认移除',
		cssClasses: ['suggested-action'],
	});
	const buttons = new Gtk.Box({
		orientation: Gtk.Orientation.HORIZONTAL,
		spacing: 8,
		halign: Gtk.Align.END,
		marginTop: 12,
		marginBottom: 12,
		marginStart: 12,
		marginEnd: 12,
	});
	buttons.append(cancel);
	buttons.append(apply);
	const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
	content.append(pathLabel);
	content.append(scroll);
	content.append(buttons);
	const dialog = new Adw.Dialog({
		child: content,
		contentWidth: 760,
		contentHeight: 620,
		title: plan.action === 'install' ? '确认 Agent 接入' : '确认移除 Agent 接入',
	});
	cancel.on('clicked', () => dialog.close());
	apply.on('clicked', () => {
		apply.sensitive = false;
		apply.label = plan.action === 'install' ? '正在接入…' : '正在移除…';
		void state.applyIntegration(plan).then((applied) => {
			if (applied) dialog.close();
			else {
				apply.sensitive = true;
				apply.label = plan.action === 'install' ? '确认接入' : '确认移除';
			}
		});
	});
	dialog.present(parent);
}

function createAboutPage(): InstanceType<typeof Adw.StatusPage> {
	const image = Gtk.Picture.newForFilename(ICON_PATH);
	image.widthRequest = 128;
	image.heightRequest = 128;
	const version = new Adw.ActionRow({
		title: '版本',
		subtitle: packageMetadata.version,
	});
	const author = new Adw.ActionRow({
		title: '作者',
		subtitle: 'Geequlim',
	});
	const project = new Adw.ActionRow({
		title: '项目性质',
		subtitle: '源码公开项目',
	});
	const license = new Adw.ActionRow({
		title: '软件许可',
		subtitle: 'PolyForm Noncommercial 1.0.0（禁止商业使用）',
	});
	const group = new Adw.PreferencesGroup({ title: '项目信息' });
	group.add(version);
	group.add(author);
	group.add(project);
	group.add(license);
	return new Adw.StatusPage({
		title: APPLICATION_NAME,
		description: '让硬件灯光表达 Agent 的工作状态',
		paintable: image.paintable,
		child: new Adw.Clamp({ child: group, maximumSize: 560 }),
	});
}

function createPreviewWindow(
	application: InstanceType<typeof Adw.Application>,
	rpc: AgentGlowRpcClient,
): void {
	const label = new Gtk.Label({
		label: STATE_LABELS.working,
		cssClasses: ['title-1', 'agent-glow-preview-text'],
	});
	const detail = new Gtk.Label({
		label: '正在连接灯光预览…',
		cssClasses: ['agent-glow-preview-text'],
	});
	const surface = new Gtk.Box({
		orientation: Gtk.Orientation.VERTICAL,
		spacing: 12,
		halign: Gtk.Align.FILL,
		valign: Gtk.Align.FILL,
		hexpand: true,
		vexpand: true,
		cssClasses: ['agent-glow-preview'],
	});
	surface.append(label);
	surface.append(detail);
	const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
	content.append(surface);
	const closeButton = new Gtk.Button({
		iconName: 'window-close-symbolic',
		tooltipText: '关闭预览',
		valign: Gtk.Align.CENTER,
	});
	const header = new Adw.HeaderBar({
		titleWidget: new Adw.WindowTitle({ title: '灯光预览' }),
		showStartTitleButtons: false,
		showEndTitleButtons: false,
	});
	header.packEnd(closeButton);
	const toolbar = new Adw.ToolbarView({ content });
	toolbar.addTopBar(header);
	const window = new Adw.Window({
		application,
		content: toolbar,
		defaultWidth: 560,
		defaultHeight: 520,
		title: '灯光预览',
	});
	const provider = new Gtk.CssProvider();
	const display = Gdk.Display.getDefault();
	if (!display) throw new Error('GTK display is unavailable');
	Gtk.StyleContext.addProviderForDisplay(
		display,
		provider,
		Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
	);
	let stageIndex = 0;
	const selectedState = (): ConfigurableState => CONFIGURABLE_STATES[stageIndex] ?? 'working';
	const selectNextStage = (): void => {
		stageIndex = (stageIndex + 1) % CONFIGURABLE_STATES.length;
		const state = selectedState();
		label.label = STATE_LABELS[state];
		detail.label = previewStateHint(state);
		void rpc.updatePreview(state).catch((error: unknown) => {
			detail.label = error instanceof Error ? error.message : String(error);
		});
	};
	void rpc.startPreview(selectedState()).catch((error: unknown) => {
		detail.label = error instanceof Error ? error.message : String(error);
	});
	const stageTimer = setInterval(selectNextStage, 5000);
	const frameTimer = setInterval(() => {
		void rpc
			.getPreviewFrame()
			.then((frame) => {
				if (!frame.active) {
					detail.label = '预览已结束';
					return;
				}
				const rgb = parseHex(frame.color);
				const scaled = rgb.map((channel) => Math.round(channel * frame.intensity));
				provider.loadFromString(
					`.agent-glow-preview {
						background: rgb(${scaled.join(',')});
						padding: 48px;
					}
					.agent-glow-preview-text {
						color: white;
						text-shadow:
							-1px -1px 1px black,
							1px -1px 1px black,
							-1px 1px 1px black,
							1px 1px 1px black;
					}`,
				);
				detail.label = `${previewStateHint(frame.state)} · ${effectLabel(
					frame.effect,
				)} · 亮度 ${Math.round(frame.intensity * 100)}%`;
			})
			.catch((error: unknown) => {
				detail.label = error instanceof Error ? error.message : String(error);
			});
	}, 100);
	closeButton.on('clicked', () => window.close());
	window.on('close-request', () => {
		clearInterval(stageTimer);
		clearInterval(frameTimer);
		void rpc.stopPreview().catch(() => undefined);
		return false;
	});
	window.present();
}

function createSpinRow(
	title: string,
	subtitle: string,
	minimum: number,
	maximum: number,
	step: number,
	digits: number,
): InstanceType<typeof Adw.SpinRow> {
	return new Adw.SpinRow({
		title,
		subtitle,
		digits,
		adjustment: new Gtk.Adjustment({
			lower: minimum,
			upper: maximum,
			stepIncrement: step,
			pageIncrement: step * 10,
		}),
	});
}

function parseRgba(color: string): InstanceType<typeof Gdk.RGBA> {
	const rgba = new Gdk.RGBA();
	if (!rgba.parse(color)) throw new Error(`无效颜色：${color}`);
	return rgba;
}

function rgbaToHex(rgba: InstanceType<typeof Gdk.RGBA>): string {
	const channel = (value: number): string =>
		Math.round(Math.max(0, Math.min(1, value)) * 255)
			.toString(16)
			.padStart(2, '0')
			.toUpperCase();
	return `#${channel(rgba.red)}${channel(rgba.green)}${channel(rgba.blue)}`;
}

function previewStateHint(state: ConfigurableState): string {
	return {
		working: 'Agent 正在处理任务',
		tool_use: 'Agent 正在调用工具',
		waiting_permission: '等待你确认权限',
		success: '任务已经完成',
		error: '任务执行出现错误',
		paused: '任务当前已暂停',
	}[state];
}

function stateLabel(state: string): string {
	return state in STATE_LABELS ? STATE_LABELS[state as ConfigurableState] : '当前有活动任务';
}

function deviceCapabilityLabel(capability: string): string {
	return (
		{
			power: '电源开关',
			static_color: '静态颜色',
			brightness: '亮度调节',
			firmware_effect: '固件动画',
		}[capability] ?? capability
	);
}

function effectLabel(effect: string): string {
	return { static: '静态', breathe: '呼吸', stream: '数据流', pulse: '脉冲' }[effect] ?? effect;
}

function parseHex(color: string): [number, number, number] {
	return [
		Number.parseInt(color.slice(1, 3), 16),
		Number.parseInt(color.slice(3, 5), 16),
		Number.parseInt(color.slice(5, 7), 16),
	];
}
