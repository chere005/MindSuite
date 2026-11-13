<?php
declare(strict_types=1);
// The two accounts the server fixtures and cases are written for, as a config's `people` names them: ['owner' => id, 'partner' => id].
// Read from the person lists of the v2 store fixture (order 0 is the partner's list, order 1 the owner's), the same source as the unit
// tests (packages/core/test/people.setup.ts), so no account is spelled in test code. harness.php and staging-test.php hand it to
// PlanMind\pm_people_use(); a request never reads this file.
return (static function (): array {
    $store = json_decode((string)file_get_contents(__DIR__ . '/fixtures/v2-store.json'), true, 64, JSON_THROW_ON_ERROR);
    $lists = array_values(array_filter($store['lists'], fn(array $list) => $list['kind'] === 'person'));
    usort($lists, fn(array $a, array $b) => $a['order'] <=> $b['order']);
    return ['owner' => $lists[1]['id'], 'partner' => $lists[0]['id']];
})();
