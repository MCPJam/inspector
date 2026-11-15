"""Guard separate-verifier packaging and private recovery control placement."""
import json
from pathlib import Path
import tempfile
import tomllib
import unittest

from prepare import prepare


class PrepareTest(unittest.TestCase):
    def test_separate_verifier_bundles_tests_and_uses_source_artifact_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = root / "healthy"
            prepare(task, root / "packages", "healthy", "B", 42)
            config = tomllib.loads((task / "task.toml").read_text())
            self.assertEqual(config["metadata"]["benchmark_version"], "1.3.0")
            self.assertEqual(config["verifier"]["environment_mode"], "separate")
            self.assertNotIn("docker_image", config["verifier"].get("environment", {}))
            dockerfile = (task / "tests" / "Dockerfile").read_text()
            self.assertIn("COPY . /tests", dockerfile)
            self.assertIn("mv /bin/bash.real /bin/bash", dockerfile)
            script = (task / "tests" / "test.sh").read_text()
            self.assertIn("--state /private/state.json", script)
            self.assertIn("--workspace /workspace --evidence /capture", script)
            self.assertNotIn("COPY", (task / "environment" / "Dockerfile").read_text())
            # Reproduction never silently overwrites an immutable benchmark.
            with self.assertRaises(FileExistsError):
                prepare(task, root / "packages", "healthy", "B", 42)

    def test_credit_resolution_runs_only_in_the_private_sidecar(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = root / "credits"
            prepare(task, root / "packages", "credits", "D", 43)
            config = tomllib.loads((task / "task.toml").read_text())
            self.assertEqual(config["multi_step_reward_strategy"], "final")
            self.assertEqual(config["steps"][0]["verifier"]["collect"], [{"service": "fixture", "command": "python3 /fixture/control.py resolve --state /private/state.json"}])
            compose = json.loads((task / "environment" / "docker-compose.yaml").read_text())
            self.assertNotIn("volumes", compose["services"]["main"])
            self.assertEqual((task / "tests" / "prompt.txt").read_text().strip(), "D")


if __name__ == "__main__":
    unittest.main()
