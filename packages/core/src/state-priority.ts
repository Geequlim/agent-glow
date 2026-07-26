import type { SemanticState } from '@agent-glow/protocol/semantic-state';

const statePriority: Readonly<Record<SemanticState, number>> = {
	idle: 0,
	paused: 1,
	working: 2,
	tool_use: 3,
	success: 4,
	waiting_permission: 5,
	error: 6,
};

export function selectHighestPriorityState(states: readonly SemanticState[]): SemanticState {
	return states.reduce<SemanticState>((selected, state) => {
		return statePriority[state] > statePriority[selected] ? state : selected;
	}, 'idle');
}
