### Fixed

- The upgrade lane no longer fails at teardown after going green: the runner aborted its 30 s sandbox refresh loop before removing its relay container, so no tick can recreate the relay mid-shutdown and orphan it holding the data volume (`volume is in use`); `remove_project` additionally reaps unlabeled sibling containers still mounting a project's volumes before the volume rm, covering the e2e lanes the same way.
