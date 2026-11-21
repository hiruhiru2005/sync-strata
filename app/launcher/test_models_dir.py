import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sync_home as H


class ModelsDirectoryTest(unittest.TestCase):
    def setUp(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(tmp)
        self.enterContext(patch.dict(os.environ, SYNC_HOME=tmp))
        self.enterContext(patch.object(H.OS, 'default_models_dir', return_value=str(self.root / 'default')))
        os.environ.pop('SYNC_CATALOG', None)
        self.dist = self.root / 'dist.json'
        self.dist.write_text(json.dumps({'models': [{'id': 'example', 'local_dir': 'model'}],
                                         'shared': [{'local_dir': 'shared'}]}), encoding='utf-8')
        self.enterContext(patch.dict(H.LAYOUT, catalog=None, catalog_dist=str(self.dist)))

    def test_switch_and_reset_keep_old_catalog_and_files(self):
        old_catalog = Path(H.catalog_path())
        original = old_catalog.read_bytes()
        old_model = self.root / 'default' / 'model'
        old_model.mkdir(parents=True)
        sentinel = old_model / 'weights'
        sentinel.touch()
        new_root = self.root / 'other folder'
        H.settings_set('models_dir', str(new_root))
        self.assertFalse(new_root.exists())
        self.assertTrue(sentinel.exists())
        self.assertEqual(old_catalog.read_bytes(), original)
        self.assertNotEqual(Path(H.catalog_path()), old_catalog)
        self.assertEqual(H.catalog()['models'][0]['local_dir'], str(new_root / 'model'))
        self.assertEqual(H.catalog()['shared'][0]['local_dir'], str(new_root / 'shared'))
        self.assertEqual(H.settings_raw()['sessions_dir'], 'auto')
        H.settings_set('models_dir', 'auto')
        self.assertEqual(Path(H.catalog_path()), old_catalog)

    def test_pins_auto_cache_only_if_location_would_change(self):
        old_cache = str(self.root / 'original-cache')
        other_cache = str(self.root / 'other-cache')
        new_root = str(self.root / 'other')
        # Simulate the Windows cross-drive policy regardless of test OS.
        with patch.object(H, 'sessions_dir_auto', side_effect=lambda root: other_cache if root == new_root else old_cache):
            H.settings_set('models_dir', new_root)
            self.assertEqual(H.effective()['sessions_dir'], old_cache)
            self.assertEqual(H.settings_raw()['sessions_dir'], old_cache)
            H.settings_set('sessions_dir', other_cache)
            H.settings_set('models_dir', 'auto')
            self.assertEqual(H.effective()['sessions_dir'], other_cache)

    def test_invalid_path_does_not_write_settings(self):
        for value in ('relative/path', str(self.dist), str(self.root / 'a\nb')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                H.settings_set('models_dir', value)
        self.assertFalse((self.root / 'settings.json').exists())

    def test_fixed_catalog_is_not_configurable(self):
        with patch.dict(os.environ, SYNC_CATALOG=str(self.dist)):
            self.assertFalse(H.configurable_catalog())
            self.assertEqual(H.catalog_path(), str(self.dist))


if __name__ == '__main__':
    unittest.main()
