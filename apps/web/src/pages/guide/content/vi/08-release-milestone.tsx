/*
 * Vietnamese edition, chapter 08-release-milestone (US-119). Converted from the BA's static page
 * `public/guide/08-release-milestone.html`.
 */
import {
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DocTable,
  InstructionList,
  Lead,
  Section,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-08">
        <div>
          <ChapterEyebrow>PHẦN 08 · RELEASE & MILESTONE</ChapterEyebrow>
          <h2>Quản lý mốc giao hàng và đọc tiến độ đúng nơi</h2>
          <Lead>
            <strong>Release</strong> xác định một cửa sổ giao hàng của Project.{' '}
            <strong>Milestone</strong> ghi nhận mốc quan trọng và có thể liên kết nhiều Release. Tạo
            và chỉnh hai đối tượng này tại <strong>Plan → Timeboxes</strong>; xem tiến độ Release
            tại <strong>Portfolio → Release Tracking</strong>.
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ làm được">
          <strong>Sau phần này, bạn sẽ làm được</strong>
          <ul>
            <li>Chọn đúng màn hình quản lý hoặc theo dõi Release.</li>
            <li>Tạo Release với ngày và trạng thái hợp lệ.</li>
            <li>Tạo Milestone và hiểu khi nào ngày được nhập tay.</li>
            <li>Liên kết Work Item, Feature hoặc Epic đúng loại Artifacts.</li>
            <li>Đọc các nhóm dữ liệu và biểu đồ Burnup trong Release Tracking.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="chon-dung-man-hinh"
        number="08.1"
        title="Chọn đúng màn hình trước khi thao tác"
        lead="Thông tin Release và số liệu tiến độ nằm ở hai khu vực khác nhau."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Khi cần</th>
              <th>Mở tại</th>
              <th>Thực hiện ở đây</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Tạo hoặc sửa Release</strong>
              </td>
              <td>Plan → Timeboxes → Releases</td>
              <td>Quản lý Name, Theme, ngày, trạng thái, metadata, Release Notes và Artifacts.</td>
            </tr>
            <tr>
              <td>
                <strong>Tạo hoặc sửa Milestone</strong>
              </td>
              <td>Plan → Timeboxes → Milestones</td>
              <td>
                Quản lý mốc, ngày mục tiêu, Owner, phạm vi Project/Team, Release liên kết và
                Artifacts.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Đọc tiến độ Release</strong>
              </td>
              <td>Portfolio → Release Tracking</td>
              <td>
                Đọc các nhóm Feature/Work Item, trạng thái theo Points hoặc Count và biểu đồ Burnup.
              </td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          <strong>Quyền truy cập:</strong> Workspace Admin và Admin của Project có thể quản lý
          Release/Milestone trong phạm vi được phép. Editor không dùng các màn hình lập kế hoạch
          này. Trước khi thao tác, hãy kiểm tra Project và Team trên thanh đầu trang.
        </p>
        <p>
          <strong>Không tạo Release trong Release Tracking.</strong> Đây là màn hình theo dõi.
          Release Planning và phân tích Dependencies chưa phải chức năng đang hoạt động trong hướng
          dẫn này.
        </p>
      </Section>
      <Section
        id="tao-release"
        number="08.2"
        title="Tạo Release"
        lead="Dùng Release khi cần xác định khoảng thời gian và mục tiêu cho một đợt giao hàng của Project."
      >
        <p>
          <strong>Trước khi bắt đầu:</strong> chọn đúng Project, chuẩn bị tên Release, ngày bắt đầu,
          ngày giao dự kiến và trạng thái ban đầu.
        </p>
        <DocTable>
          <thead>
            <tr>
              <th>Trường</th>
              <th>Cần nhập gì</th>
              <th>Lưu ý</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Release name</strong>
              </td>
              <td>Tên ngắn gọn cho đợt giao hàng.</td>
              <td>Bắt buộc và nên phân biệt được với các Release khác.</td>
            </tr>
            <tr>
              <td>
                <strong>Theme</strong>
              </td>
              <td>Mục tiêu hoặc chủ đề chính.</td>
              <td>Có thể bổ sung chi tiết sau.</td>
            </tr>
            <tr>
              <td>
                <strong>Start Date / Release Date</strong>
              </td>
              <td>Khoảng thời gian dự kiến.</td>
              <td>Release Date không được sớm hơn Start Date.</td>
            </tr>
            <tr>
              <td>
                <strong>Status</strong>
              </td>
              <td>Planning, Active hoặc Accepted.</td>
              <td>Đây là trạng thái Release, độc lập với trạng thái US/DE.</td>
            </tr>
            <tr>
              <td>
                <strong>Description</strong>
              </td>
              <td>Phạm vi hoặc ghi chú ngắn.</td>
              <td>Không dùng thay cho Release Notes chi tiết.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Plan → Timeboxes</strong>
              <p>
                Trong bộ chọn Timebox, chọn <b>Releases</b>. Danh sách chỉ hiển thị Release của
                Project hiện tại.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn Add New</strong>
              <p>
                Form Create Release mở với các trường Release name, Theme, Start Date, Release Date,
                Status và Description.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Nhập tên, ngày và trạng thái</strong>
              <p>
                Chọn Planning khi Release còn đang chuẩn bị; Active khi đợt giao hàng đang diễn ra;
                Accepted khi kết quả đã được chấp nhận.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Chọn cách hoàn tất</strong>
              <p>
                <b>Create Release</b> lưu và quay lại danh sách. <b>Create with details</b> mở trang
                Release Detail để bổ sung metadata và nội dung chi tiết.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Kiểm tra Release vừa tạo</strong>
              <p>
                Đối chiếu tên, Project, ngày và State trên danh sách hoặc Release Detail trước khi
                gán Work Item.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          Trong Release Detail, bạn có thể bổ sung <strong>Release Theme</strong>,{' '}
          <strong>Notes & Scope Deliverables</strong>, <strong>Release Notes</strong>, Planned
          Velocity, Plan Estimate và Version. Trang này không hiển thị Burnup hoặc tiến độ Accepted;
          các số đó nằm trong Release Tracking.
        </p>
      </Section>
      <Section
        id="tao-milestone"
        number="08.3"
        title="Tạo Milestone"
        lead="Dùng Milestone cho một mốc demo, nghiệm thu hoặc kết quả quan trọng có thể trải qua nhiều Release."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Plan → Timeboxes → Milestones</strong>
              <p>Màn hình hiển thị Name, Target Start Date, Target End Date và Status.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn Add New</strong>
              <p>
                Nhập Milestone name; chọn Status, Owner và bổ sung Description hoặc Notes khi cần.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Chọn ngày hoặc Release liên kết</strong>
              <p>
                Nếu chưa chọn Associated Releases, nhập Target Start và Target End. Nếu chọn một
                hoặc nhiều Release, ngày mục tiêu sẽ được tính từ các Release đó.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Chọn Create Milestone</strong>
              <p>
                Sau khi lưu, mở Milestone Detail để kiểm tra ngày, trạng thái, Release liên kết và
                phạm vi Project/Team.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Trạng thái Milestone</strong> gồm Planned, At Risk, Met, Missed, Cancelled và
          Completed. Đây là trạng thái của mốc; không dùng thay cho trạng thái Release hoặc trạng
          thái Work Item.
        </p>
        <p>Milestone không có velocity, Task Estimate hoặc quy tắc carry-over của Iteration.</p>
      </Section>
      <Section
        id="lien-ket-release-milestone"
        number="08.4"
        title="Hiểu liên kết và ngày mục tiêu"
        lead="Release và Milestone có thể được tạo theo bất kỳ thứ tự nào và liên kết nhiều-nhiều."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Tình trạng liên kết</th>
              <th>Cách xác định ngày Milestone</th>
              <th>Khi thay đổi</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Không có Release liên kết</strong>
              </td>
              <td>Target Start và Target End được nhập tay.</td>
              <td>Người có quyền có thể chỉnh trực tiếp hai ngày.</td>
            </tr>
            <tr>
              <td>
                <strong>Có một Release</strong>
              </td>
              <td>Lấy Start Date và Release Date của Release đó.</td>
              <td>Ngày Milestone trở thành giá trị suy ra.</td>
            </tr>
            <tr>
              <td>
                <strong>Có nhiều Release</strong>
              </td>
              <td>Target Start là ngày bắt đầu sớm nhất; Target End là ngày giao muộn nhất.</td>
              <td>Đổi danh sách Release sẽ tính lại khoảng ngày.</td>
            </tr>
            <tr>
              <td>
                <strong>Gỡ toàn bộ Release</strong>
              </td>
              <td>Milestone trở lại chế độ nhập ngày thủ công.</td>
              <td>Kiểm tra và nhập lại ngày phù hợp trước khi lưu.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          Release và Milestone là hai quan hệ độc lập trên Work Item. Thay đổi Release của một US/DE{' '}
          <strong>không tự xóa</strong> các Milestone đã chọn. Khi Work Item đã có Release, danh
          sách Milestone mới để thêm chỉ hiển thị các Milestone liên kết với Release đó.
        </p>
      </Section>
      <Section
        id="quan-ly-artifacts"
        number="08.5"
        title="Quản lý Artifacts đúng loại"
        lead="Artifacts là các đối tượng công việc hoặc Portfolio Item được liên kết với Release hoặc Milestone."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Phạm vi</th>
              <th>Artifacts hợp lệ</th>
              <th>Quy tắc cần nhớ</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Release</strong>
              </td>
              <td>User Story, Defect và Feature được gán trực tiếp.</td>
              <td>
                Mỗi US/DE chỉ có tối đa một Release. Task và Epic không phải Release Artifact.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Milestone</strong>
              </td>
              <td>
                Story, Defect, Feature và Epic; có thể bao gồm hậu duệ được kế thừa từ Feature/Epic.
              </td>
              <td>Một Work Item có thể thuộc nhiều Milestone nếu vẫn nằm trong phạm vi hợp lệ.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Gán Release từ Work Item hoặc Feature</strong>
              <p>
                Mở Backlog, Work Item Detail hoặc Portfolio Item phù hợp và chọn Release. Chọn
                Release khác sẽ thay thế liên kết Release cũ nhưng không đổi Iteration hoặc
                Milestone.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Kiểm tra tab Release Artifacts</strong>
              <p>
                Mở Release Detail → Artifacts để tìm và kiểm tra các item đã liên kết. Add Artifact
                cho phép chọn Story/Defect có sẵn; thao tác này không tạo Work Item mới.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Gán Milestone bằng danh sách chọn nhiều</strong>
              <p>
                Trên Work Item, chọn một hoặc nhiều Milestone hợp lệ. Các Milestone đã chọn phải
                luôn còn hiển thị khi bạn mở lại trường này.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Kiểm tra Milestone Artifacts</strong>
              <p>
                Đối chiếu item gán trực tiếp và các item được kế thừa qua Feature/Epic. Dữ liệu
                trùng phải chỉ được tính một lần.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Không dùng Add Artifact để thay thế luồng tạo công việc.</strong> Khi cần tạo
          US/DE hoặc Feature mới, hãy tạo ở Backlog hoặc Portfolio rồi gán Release/Milestone theo
          đúng trường của đối tượng.
        </p>
      </Section>
      <Section
        id="doc-release-tracking"
        number="08.6"
        title="Đọc Release Tracking"
        lead="Dùng Portfolio → Release Tracking để xem phạm vi và tiến độ của Release đang chọn."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Kiểm tra Project và Team</strong>
              <p>
                Release Tracking dùng phạm vi toàn cục trên thanh đầu trang. Chuyển Team sẽ tính lại
                danh sách và biểu đồ; trang không có bộ lọc Project/Team thứ hai.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn Release</strong>
              <p>
                Dùng nút trước, danh sách Release và nút sau ở đầu trang. Khoảng ngày bên cạnh tên
                là cửa sổ của Release đang đọc.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Chọn Chart Unit</strong>
              <p>
                <b>Points</b> cộng Plan Estimate của Story/Defect; <b>Count</b> đếm Story/Defect.
                Lựa chọn này áp dụng cho cả cột Status và Burnup.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Chọn nhóm cần xem</strong>
              <p>
                <b>Features in Release</b> là Feature gán trực tiếp; <b>Derived Features</b> là
                Feature xuất hiện do có Story/Defect con trong Release;{' '}
                <b>Unparented Stories & Defects</b> là item không có Feature cha.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Đọc Status và Burnup</strong>
              <p>
                Planned lấy Story/Defect thuộc Release. Accepted chỉ tính item ở trạng thái Accepted
                hoặc Release; Completed chưa được coi là Accepted.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          Biểu đồ Burnup hiển thị Accepted, Planned, Preliminary Estimate và đường mục tiêu trong
          cửa sổ Release. Dòng Iteration bên dưới giúp đối chiếu các chu kỳ đi qua khoảng thời gian
          đó.
        </p>
        <p>
          <strong>Khoảng trống lịch sử không phải số 0.</strong> Ngày chưa có snapshot được hiển thị
          thành khoảng trống. Không kết luận tiến độ bằng 0 nếu lịch sử đang thiếu hoặc chưa đầy đủ.
        </p>
        <p>
          <strong>Dependencies · Future</strong> chỉ là nhãn cho chức năng tương lai; không dùng nó
          để đánh giá rủi ro phụ thuộc trong bản hiện tại.
        </p>
      </Section>
      <Section
        id="xu-ly-release-milestone"
        number="08.7"
        title="Xử lý tình huống thường gặp"
        lead="Kiểm tra quyền, phạm vi và quan hệ trước khi tạo lại dữ liệu."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Không thấy Release hoặc Milestone</strong>
              <p>
                Kiểm tra đúng Project, bỏ Search/Filters và xác nhận tài khoản có quyền Workspace
                Admin hoặc Admin tại Project đó.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Không tạo hoặc sửa được</strong>
              <p>
                Editor không có quyền quản lý Timeboxes. Liên hệ Project Admin thay vì yêu cầu thêm
                Team membership.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Ngày Milestone không chỉnh được</strong>
              <p>
                Milestone đang liên kết ít nhất một Release nên ngày được suy ra. Kiểm tra
                Associated Releases trước khi thay đổi liên kết.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Item không có trong Release Artifacts</strong>
              <p>
                Đối chiếu Project, loại item và trường Release. US/DE có thể đang thuộc Release
                khác; Task và Epic không xuất hiện trong danh sách này.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Không thấy Milestone để chọn trên Work Item</strong>
              <p>
                Nếu item đã có Release, chỉ Milestone liên kết với Release đó được đưa vào danh sách
                lựa chọn mới. Các Milestone đã chọn trước đó không tự mất.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Burnup trống hoặc đứt đoạn</strong>
              <p>
                Kiểm tra Release, phạm vi Team, Chart Unit và chất lượng lịch sử. Khoảng trống
                snapshot không được diễn giải thành số 0.
              </p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
      <CheckUnderstanding>
        <strong>Tự kiểm tra trước khi sang phần tiếp theo</strong>
        <ul>
          <li>Bạn biết nơi tạo Release khác nơi đọc Release Tracking chưa?</li>
          <li>Bạn biết khi nào ngày Milestone được nhập tay hoặc suy ra chưa?</li>
          <li>Bạn phân biệt Release Artifact với Milestone Artifact chưa?</li>
          <li>Bạn biết Completed chưa được tính vào Accepted trong Release Tracking chưa?</li>
        </ul>
      </CheckUnderstanding>
    </>
  )
}
