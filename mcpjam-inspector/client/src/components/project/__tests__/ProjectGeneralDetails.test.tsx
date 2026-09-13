import {render,screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {it,expect,vi} from "vitest";
import {ProjectGeneralDetails} from "../ProjectGeneralDetails";
vi.mock("../../settings/SettingsDraftProvider",()=>({useSettingsDraft:vi.fn()}));
it("saves the edited fields together",async()=>{
 const save=vi.fn().mockResolvedValue(undefined);render(<ProjectGeneralDetails name="Demo" description="Old" canEdit icon={null} onSave={save}/>);
 await userEvent.clear(screen.getByLabelText("Project name"));await userEvent.type(screen.getByLabelText("Project name"),"New name");
 await userEvent.click(screen.getByRole("button",{name:"Save changes"}));expect(save).toHaveBeenCalledWith({name:"New name",description:"Old"});
});
it("keeps details read-only for members",()=>{
 render(<ProjectGeneralDetails name="Demo" description="Old" canEdit={false} icon={null} onSave={vi.fn()}/>);
 expect(screen.getByLabelText("Project name")).toHaveAttribute("readonly");expect(screen.queryByRole("button",{name:"Save changes"})).not.toBeInTheDocument();
});
